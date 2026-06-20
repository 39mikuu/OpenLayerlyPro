import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  files,
  memberships,
  membershipTiers,
  postFiles,
  posts,
  postTranslations,
  tasks,
  users,
} from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import { canAccessFile } from "@/modules/download";
import { claimDueTasks, enqueueTask } from "@/modules/tasks";
import { dispatchClaimedTask } from "@/modules/tasks/dispatcher";
import { isTranslationStale } from "@/modules/translation/review";

import {
  archivePost,
  attachFileToPost,
  cancelPostSchedule,
  detachFileFromPost,
  executeScheduledPublish,
  getLocalizedPost,
  getPostById,
  getPublishedPostBySlug,
  listPostFiles,
  listPosts,
  publishPostNow,
  reschedulePost,
  restorePost,
  schedulePost,
  updatePost,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const adminActor = () => ({ type: "admin" as const, id: randomUUID() });

type PublishTaskPayload = {
  postId: string;
  scheduleToken: string;
  correlationId: string;
  schedulingAuditId: string;
};

describeWithDatabase("scheduled publishing integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(postTranslations);
    await db.delete(postFiles);
    await db.delete(auditEvents);
    await db.delete(tasks);
    await db.delete(posts);
    await db.delete(files);
    await db.delete(memberships);
    await db.delete(membershipTiers);
    await db.delete(users);
  });

  async function databaseNow(): Promise<Date> {
    const result = await db.execute<{ now: Date | string }>(sql`select now() as now`);
    const row = result[0];
    if (!row) throw new Error("database clock unavailable");
    const now = row.now instanceof Date ? row.now : new Date(row.now);
    if (Number.isNaN(now.getTime())) throw new Error("invalid database clock");
    return now;
  }

  async function futureDate(minutes = 60): Promise<Date> {
    const now = await databaseNow();
    return new Date(now.getTime() + minutes * 60_000);
  }

  async function seedDraft(
    overrides: Partial<typeof posts.$inferInsert> = {},
  ): Promise<typeof posts.$inferSelect> {
    const [post] = await db
      .insert(posts)
      .values({
        title: "Original title",
        slug: `post-${randomUUID()}`,
        summary: "Original summary",
        body: "Original body",
        originalLocale: "zh",
        visibility: "public",
        status: "draft",
        ...overrides,
      })
      .returning();
    if (!post) throw new Error("failed to seed post");
    return post;
  }

  async function scheduledTaskPayload(postId: string): Promise<PublishTaskPayload> {
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.kind, "publish_post"), eq(tasks.status, "pending")))
      .orderBy(tasks.createdAt)
      .limit(1);
    if (!task || task.payloadJson === null || typeof task.payloadJson !== "object") {
      throw new Error(`missing publish task for ${postId}`);
    }
    return task.payloadJson as PublishTaskPayload;
  }

  it("persists schedule, audit, and durable task atomically with the causal payload", async () => {
    const original = await seedDraft();
    const scheduledAt = await futureDate();
    const actor = adminActor();

    const scheduled = await schedulePost(original.id, { scheduledAt, actor });
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, original.id), eq(auditEvents.action, "post.scheduled")));
    const [task] = await db.select().from(tasks).where(eq(tasks.kind, "publish_post"));

    expect(scheduled).toMatchObject({
      status: "draft",
      scheduledAt,
      publishedAt: null,
    });
    expect(scheduled.scheduleToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(scheduled.contentUpdatedAt).toEqual(original.contentUpdatedAt);
    expect(audit).toMatchObject({
      actorType: "admin",
      actorId: actor.id,
      correlationId: expect.any(String),
      causationId: null,
      beforeJson: {
        status: "draft",
        publishedAt: null,
        scheduledAt: null,
        scheduleToken: null,
      },
      afterJson: {
        status: "draft",
        publishedAt: null,
        scheduledAt: scheduledAt.toISOString(),
        scheduleToken: scheduled.scheduleToken,
      },
    });
    expect(task).toMatchObject({
      status: "pending",
      runAfter: scheduledAt,
      dedupeKey: `publish_post:${original.id}:${scheduled.scheduleToken}`,
      payloadJson: {
        postId: original.id,
        scheduleToken: scheduled.scheduleToken,
        correlationId: audit?.correlationId,
        schedulingAuditId: audit?.id,
      },
    });
  });

  it("rolls back post and audit when task enqueue fails", async () => {
    const original = await seedDraft();

    await expect(
      schedulePost(
        original.id,
        { scheduledAt: await futureDate(), actor: adminActor() },
        {
          createId: randomUUID,
          audit: recordAudit,
          enqueue: async () => {
            throw new Error("forced enqueue failure");
          },
        },
      ),
    ).rejects.toThrow("forced enqueue failure");

    const stored = await getPostById(original.id);
    expect(stored).toMatchObject({ scheduledAt: null, scheduleToken: null });
    await expect(
      db.select().from(auditEvents).where(eq(auditEvents.entityId, original.id)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("rolls back post and prevents enqueue when audit creation fails", async () => {
    const original = await seedDraft();
    let enqueueCalled = false;

    await expect(
      schedulePost(
        original.id,
        { scheduledAt: await futureDate(), actor: adminActor() },
        {
          createId: randomUUID,
          audit: async () => {
            throw new Error("forced audit failure");
          },
          enqueue: async (...args) => {
            enqueueCalled = true;
            await enqueueTask(...args);
          },
        },
      ),
    ).rejects.toThrow("forced audit failure");

    expect(enqueueCalled).toBe(false);
    const stored = await getPostById(original.id);
    expect(stored).toMatchObject({ scheduledAt: null, scheduleToken: null });
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("reschedules with a new token and dedupe key and rejects stale tokens", async () => {
    const original = await seedDraft();
    const actor = adminActor();
    const first = await schedulePost(original.id, {
      scheduledAt: await futureDate(60),
      actor,
    });
    const second = await reschedulePost(original.id, {
      scheduledAt: await futureDate(120),
      expectedScheduleToken: first.scheduleToken!,
      actor,
    });

    expect(second.scheduleToken).not.toBe(first.scheduleToken);
    expect(second.contentUpdatedAt).toEqual(original.contentUpdatedAt);
    const queued = await db.select().from(tasks).orderBy(tasks.createdAt);
    expect(queued).toHaveLength(2);
    expect(queued.map((task) => task.dedupeKey)).toEqual([
      `publish_post:${original.id}:${first.scheduleToken}`,
      `publish_post:${original.id}:${second.scheduleToken}`,
    ]);
    await expect(
      reschedulePost(original.id, {
        scheduledAt: await futureDate(180),
        expectedScheduleToken: first.scheduleToken!,
        actor,
      }),
    ).rejects.toMatchObject({ status: 409, code: "postPublishingStale" });
    await expect(
      cancelPostSchedule(original.id, {
        expectedScheduleToken: first.scheduleToken!,
        actor,
      }),
    ).rejects.toMatchObject({ status: 409, code: "postPublishingStale" });
  });

  it("treats cancelled and superseded scheduled tasks as successful no-ops", async () => {
    const firstPost = await seedDraft();
    const actor = adminActor();
    const first = await schedulePost(firstPost.id, {
      scheduledAt: await futureDate(),
      actor,
    });
    const cancelledPayload = await scheduledTaskPayload(firstPost.id);
    const cancelled = await cancelPostSchedule(firstPost.id, {
      expectedScheduleToken: first.scheduleToken!,
      actor,
    });
    expect(cancelled.contentUpdatedAt).toEqual(firstPost.contentUpdatedAt);
    await expect(executeScheduledPublish(cancelledPayload)).resolves.toMatchObject({
      outcome: "noop",
    });

    const secondPost = await seedDraft();
    const scheduled = await schedulePost(secondPost.id, {
      scheduledAt: await futureDate(60),
      actor,
    });
    const oldPayload = await scheduledTaskPayload(secondPost.id);
    const rescheduled = await reschedulePost(secondPost.id, {
      scheduledAt: await futureDate(120),
      expectedScheduleToken: scheduled.scheduleToken!,
      actor,
    });
    await expect(executeScheduledPublish(oldPayload)).resolves.toMatchObject({ outcome: "noop" });

    await db
      .update(posts)
      .set({ scheduledAt: sql`now() - interval '1 second'` })
      .where(eq(posts.id, secondPost.id));
    const allTasks = await db.select().from(tasks).orderBy(tasks.createdAt);
    const newPayload = allTasks.at(-1)?.payloadJson as PublishTaskPayload;
    await expect(executeScheduledPublish(newPayload)).resolves.toMatchObject({
      outcome: "published",
    });
    const stored = await getPostById(secondPost.id);
    expect(stored).toMatchObject({
      status: "published",
      scheduledAt: null,
      scheduleToken: null,
    });
    expect(rescheduled.scheduleToken).toBe(newPayload.scheduleToken);
  });

  it("publishes a schedule once under immediate-publish competition and keeps audit causality", async () => {
    const original = await seedDraft();
    const actor = adminActor();
    const scheduled = await schedulePost(original.id, {
      scheduledAt: await futureDate(),
      actor,
    });
    const payload = await scheduledTaskPayload(original.id);
    await db
      .update(posts)
      .set({ scheduledAt: sql`now() - interval '1 second'` })
      .where(eq(posts.id, original.id));

    const results = await Promise.allSettled([
      executeScheduledPublish(payload),
      publishPostNow(original.id, {
        expectedState: "scheduled",
        expectedScheduleToken: scheduled.scheduleToken!,
        actor,
      }),
    ]);

    const stored = await getPostById(original.id);
    expect(stored).toMatchObject({ status: "published", scheduledAt: null, scheduleToken: null });
    const publishAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, original.id), eq(auditEvents.action, "post.published")));
    expect(publishAudits).toHaveLength(1);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);

    const [scheduleAudit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, original.id), eq(auditEvents.action, "post.scheduled")));
    const publishAudit = publishAudits[0]!;
    if (publishAudit.actorType === "system") {
      expect(publishAudit).toMatchObject({
        correlationId: scheduleAudit?.correlationId,
        causationId: scheduleAudit?.id,
      });
    }
  });

  it("is idempotent and writes no second publish audit on task replay", async () => {
    const original = await seedDraft();
    await schedulePost(original.id, { scheduledAt: await futureDate(), actor: adminActor() });
    const payload = await scheduledTaskPayload(original.id);
    await db
      .update(posts)
      .set({ scheduledAt: sql`now() - interval '1 second'` })
      .where(eq(posts.id, original.id));

    await expect(executeScheduledPublish(payload)).resolves.toMatchObject({ outcome: "published" });
    await expect(executeScheduledPublish(payload)).resolves.toMatchObject({ outcome: "noop" });
    const publishAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, original.id), eq(auditEvents.action, "post.published")));
    expect(publishAudits).toHaveLength(1);
    expect(publishAudits[0]).toMatchObject({
      actorType: "system",
      correlationId: payload.correlationId,
      causationId: payload.schedulingAuditId,
    });
  });

  it("precisely defers an anomalously early claim without consuming an attempt", async () => {
    const original = await seedDraft();
    const scheduled = await schedulePost(original.id, {
      scheduledAt: await futureDate(60),
      actor: adminActor(),
    });
    await db
      .update(tasks)
      .set({ runAfter: sql`now() - interval '1 second'` })
      .where(eq(tasks.kind, "publish_post"));
    const [claimed] = await claimDueTasks(1, { lockToken: "early-publish-claim" });
    expect(claimed).toMatchObject({ attempts: 1, status: "processing" });

    await dispatchClaimedTask(claimed!);

    const [deferred] = await db.select().from(tasks).where(eq(tasks.id, claimed!.id));
    expect(deferred).toMatchObject({
      status: "pending",
      attempts: 0,
      runAfter: scheduled.scheduledAt,
      lockedAt: null,
      lockedBy: null,
      leaseUntil: null,
    });
    expect(await getPostById(original.id)).toMatchObject({
      status: "draft",
      scheduledAt: scheduled.scheduledAt,
      scheduleToken: scheduled.scheduleToken,
    });
    const publishAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, original.id), eq(auditEvents.action, "post.published")));
    expect(publishAudits).toHaveLength(0);
  });

  it("does not let an old task republish after immediate publish, archive, and restore", async () => {
    const original = await seedDraft();
    const actor = adminActor();
    const scheduled = await schedulePost(original.id, {
      scheduledAt: await futureDate(),
      actor,
    });
    const payload = await scheduledTaskPayload(original.id);
    await publishPostNow(original.id, {
      expectedState: "scheduled",
      expectedScheduleToken: scheduled.scheduleToken!,
      actor,
    });
    await archivePost(original.id, { actor });
    const restored = await restorePost(original.id, { actor });

    expect(restored).toMatchObject({
      status: "draft",
      publishedAt: null,
      scheduledAt: null,
      scheduleToken: null,
    });
    await expect(executeScheduledPublish(payload)).resolves.toMatchObject({ outcome: "noop" });
    expect(await getPostById(original.id)).toMatchObject({ status: "draft", publishedAt: null });
    const publishAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, original.id), eq(auditEvents.action, "post.published")));
    expect(publishAudits).toHaveLength(1);
  });

  it("updates contentUpdatedAt only for actual source content changes", async () => {
    const oldTime = new Date("2025-01-01T00:00:00.000Z");
    const original = await seedDraft({ contentUpdatedAt: oldTime, updatedAt: oldTime });
    const [draftTranslation] = await db
      .insert(postTranslations)
      .values({
        postId: original.id,
        locale: "ja",
        title: "Draft translation",
        status: "draft",
        sourceUpdatedAt: oldTime,
      })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Supporter",
        slug: `supporter-${randomUUID()}`,
        priceLabel: "500",
        level: 10,
        durationDays: 31,
      })
      .returning();
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `files/${randomUUID()}`,
        originalName: "cover.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        purpose: "content_image",
      })
      .returning();

    const metadataOnly = await updatePost(original.id, {
      visibility: "login",
      requiredTierId: tier!.id,
      coverFileId: file!.id,
    });
    expect(metadataOnly.contentUpdatedAt).toEqual(oldTime);
    const sameContent = await updatePost(original.id, { title: original.title });
    expect(sameContent.contentUpdatedAt).toEqual(oldTime);
    await attachFileToPost({ postId: original.id, fileId: file!.id, kind: "image" });
    await detachFileFromPost(original.id, file!.id);
    expect((await getPostById(original.id))!.contentUpdatedAt).toEqual(oldTime);

    const changed = await updatePost(original.id, {
      title: "Changed title",
      summary: "Changed summary",
      body: "Changed body",
      originalLocale: "en",
    });
    expect(changed.contentUpdatedAt.getTime()).toBeGreaterThan(oldTime.getTime());
    expect(isTranslationStale(changed.contentUpdatedAt, draftTranslation?.sourceUpdatedAt)).toBe(
      true,
    );

    const contentVersion = changed.contentUpdatedAt;
    const scheduled = await schedulePost(original.id, {
      scheduledAt: await futureDate(),
      actor: adminActor(),
    });
    expect(scheduled.contentUpdatedAt).toEqual(contentVersion);
    const published = await publishPostNow(original.id, {
      expectedState: "scheduled",
      expectedScheduleToken: scheduled.scheduleToken!,
      actor: adminActor(),
    });
    expect(published.contentUpdatedAt).toEqual(contentVersion);
    const archived = await archivePost(original.id, { actor: adminActor() });
    expect(archived.contentUpdatedAt).toEqual(contentVersion);
    const restored = await restorePost(original.id, { actor: adminActor() });
    expect(restored.contentUpdatedAt).toEqual(contentVersion);
  });

  it("keeps an approved stale translation public after source content changes", async () => {
    const original = await seedDraft({ contentUpdatedAt: new Date("2025-01-01T00:00:00Z") });
    const [translation] = await db
      .insert(postTranslations)
      .values({
        postId: original.id,
        locale: "ja",
        title: "承認済み翻訳",
        summary: "翻訳概要",
        body: "翻訳本文",
        status: "published",
        source: "manual",
        sourceUpdatedAt: original.contentUpdatedAt,
        publishedAt: new Date("2025-01-02T00:00:00Z"),
      })
      .returning();
    const actor = adminActor();
    await publishPostNow(original.id, { expectedState: "draft", actor });
    await archivePost(original.id, { actor });
    await restorePost(original.id, { actor });
    const changed = await updatePost(original.id, { body: "New source body" });
    await publishPostNow(original.id, { expectedState: "draft", actor });

    expect(isTranslationStale(changed.contentUpdatedAt, translation!.sourceUpdatedAt)).toBe(true);
    const localized = await getLocalizedPost((await getPostById(original.id))!, "ja");
    expect(localized).toMatchObject({
      title: "承認済み翻訳",
      body: "翻訳本文",
      translationSource: "manual",
    });
  });

  it("blocks content, cover, attach, and detach mutations for published and archived posts", async () => {
    const original = await seedDraft();
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `files/${randomUUID()}`,
        originalName: "attachment.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        purpose: "content_attachment",
      })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Protected tier",
        slug: `protected-${randomUUID()}`,
        priceLabel: "1000",
        level: 20,
        durationDays: 31,
      })
      .returning();
    await attachFileToPost({ postId: original.id, fileId: file!.id, kind: "attachment" });
    await publishPostNow(original.id, { expectedState: "draft", actor: adminActor() });

    await expect(updatePost(original.id, { title: "Live edit" })).rejects.toMatchObject({
      status: 409,
      code: "postNotEditable",
    });
    await expect(updatePost(original.id, { coverFileId: randomUUID() })).rejects.toMatchObject({
      status: 409,
      code: "postNotEditable",
    });
    await expect(updatePost(original.id, { requiredTierId: tier!.id })).rejects.toMatchObject({
      status: 409,
      code: "postNotEditable",
    });
    await expect(
      attachFileToPost({ postId: original.id, fileId: file!.id, kind: "attachment" }),
    ).rejects.toMatchObject({ status: 409, code: "postNotEditable" });
    await expect(detachFileFromPost(original.id, file!.id)).rejects.toMatchObject({
      status: 409,
      code: "postNotEditable",
    });

    await archivePost(original.id, { actor: adminActor() });
    await expect(updatePost(original.id, { visibility: "login" })).rejects.toMatchObject({
      status: 409,
      code: "postNotEditable",
    });
    await expect(detachFileFromPost(original.id, file!.id)).rejects.toMatchObject({
      status: 409,
      code: "postNotEditable",
    });
  });

  it("publishes the latest scheduled content and file associations", async () => {
    const original = await seedDraft({ contentUpdatedAt: new Date("2025-01-01T00:00:00Z") });
    const [firstFile, secondFile] = await db
      .insert(files)
      .values([
        {
          storageDriver: "local",
          objectKey: `files/${randomUUID()}`,
          originalName: "old.txt",
          mimeType: "text/plain",
          sizeBytes: 10,
          purpose: "content_attachment",
        },
        {
          storageDriver: "local",
          objectKey: `files/${randomUUID()}`,
          originalName: "latest.txt",
          mimeType: "text/plain",
          sizeBytes: 20,
          purpose: "content_attachment",
        },
      ])
      .returning();
    await attachFileToPost({ postId: original.id, fileId: firstFile!.id, kind: "attachment" });
    const scheduled = await schedulePost(original.id, {
      scheduledAt: await futureDate(),
      actor: adminActor(),
    });
    const payload = await scheduledTaskPayload(original.id);

    const changed = await updatePost(original.id, {
      title: "Latest title",
      body: "Latest body",
      coverFileId: secondFile!.id,
    });
    await attachFileToPost({ postId: original.id, fileId: secondFile!.id, kind: "attachment" });
    await detachFileFromPost(original.id, firstFile!.id);
    expect(changed.contentUpdatedAt.getTime()).toBeGreaterThan(original.contentUpdatedAt.getTime());
    expect((await getPostById(original.id))!.contentUpdatedAt).toEqual(changed.contentUpdatedAt);

    await db
      .update(posts)
      .set({ scheduledAt: sql`now() - interval '1 second'` })
      .where(eq(posts.id, original.id));
    await expect(executeScheduledPublish(payload)).resolves.toMatchObject({ outcome: "published" });

    const published = await getPostById(original.id);
    expect(published).toMatchObject({
      title: "Latest title",
      body: "Latest body",
      coverFileId: secondFile!.id,
      status: "published",
      scheduleToken: null,
    });
    expect(published!.contentUpdatedAt).toEqual(changed.contentUpdatedAt);
    expect((await listPostFiles(original.id)).map((row) => row.file.id)).toEqual([secondFile!.id]);
    await expect(canAccessFile(null, firstFile!)).resolves.toMatchObject({ allowed: false });
    await expect(canAccessFile(null, secondFile!)).resolves.toMatchObject({ allowed: true });
    expect(scheduled.scheduleToken).toBe(payload.scheduleToken);
  });

  it("denies ordinary download of non-published attachments and preserves published access", async () => {
    const original = await seedDraft();
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `files/${randomUUID()}`,
        originalName: "attachment.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        purpose: "content_attachment",
      })
      .returning();
    await attachFileToPost({ postId: original.id, fileId: file!.id, kind: "attachment" });

    await expect(canAccessFile(null, file!)).resolves.toMatchObject({ allowed: false });
    await publishPostNow(original.id, { expectedState: "draft", actor: adminActor() });
    await expect(canAccessFile(null, file!)).resolves.toMatchObject({
      allowed: true,
      postId: original.id,
    });
    await archivePost(original.id, { actor: adminActor() });
    await expect(canAccessFile(null, file!)).resolves.toMatchObject({ allowed: false });
  });

  it("preserves guest, login, and tier access for published attachments", async () => {
    const [loggedInUser, memberUser] = await db
      .insert(users)
      .values([
        { email: `login-${randomUUID()}@example.test` },
        { email: `member-${randomUUID()}@example.test` },
      ])
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Member",
        slug: `member-${randomUUID()}`,
        priceLabel: "1000",
        level: 10,
        durationDays: 31,
      })
      .returning();
    await db.insert(memberships).values({
      userId: memberUser!.id,
      tierId: tier!.id,
      source: "manual",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
      status: "active",
    });

    async function publishAttachment(
      visibility: "public" | "login" | "member",
      requiredTierId: string | null = null,
    ) {
      const post = await seedDraft({ visibility, requiredTierId });
      const [file] = await db
        .insert(files)
        .values({
          storageDriver: "local",
          objectKey: `files/${randomUUID()}`,
          originalName: `${visibility}.txt`,
          mimeType: "text/plain",
          sizeBytes: 10,
          purpose: "content_attachment",
        })
        .returning();
      await attachFileToPost({ postId: post.id, fileId: file!.id, kind: "attachment" });
      await publishPostNow(post.id, { expectedState: "draft", actor: adminActor() });
      return file!;
    }

    const publicFile = await publishAttachment("public");
    const loginFile = await publishAttachment("login");
    const memberFile = await publishAttachment("member", tier!.id);

    await expect(canAccessFile(null, publicFile)).resolves.toMatchObject({ allowed: true });
    await expect(canAccessFile(null, loginFile)).resolves.toMatchObject({ allowed: false });
    await expect(canAccessFile(loggedInUser!, loginFile)).resolves.toMatchObject({ allowed: true });
    await expect(canAccessFile(null, memberFile)).resolves.toMatchObject({ allowed: false });
    await expect(canAccessFile(loggedInUser!, memberFile)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(canAccessFile(memberUser!, memberFile)).resolves.toMatchObject({ allowed: true });
  });

  it("exposes published translations only through a published parent", async () => {
    const original = await seedDraft({ title: "Original title" });
    await db.insert(postTranslations).values([
      {
        postId: original.id,
        locale: "ja",
        title: "公開翻訳",
        body: "公開本文",
        status: "published",
        source: "manual",
        sourceUpdatedAt: original.contentUpdatedAt,
        publishedAt: new Date("2025-01-02T00:00:00Z"),
      },
      {
        postId: original.id,
        locale: "ja",
        title: "下書き翻訳",
        body: "下書き本文",
        status: "draft",
        source: "manual",
        sourceUpdatedAt: original.contentUpdatedAt,
      },
    ]);
    const actor = adminActor();

    await expect(getPublishedPostBySlug(original.slug)).resolves.toBeNull();
    const scheduled = await schedulePost(original.id, {
      scheduledAt: await futureDate(),
      actor,
    });
    await expect(getPublishedPostBySlug(original.slug)).resolves.toBeNull();
    await publishPostNow(original.id, {
      expectedState: "scheduled",
      expectedScheduleToken: scheduled.scheduleToken!,
      actor,
    });

    const publishedParent = await getPublishedPostBySlug(original.slug);
    expect(publishedParent).not.toBeNull();
    await expect(getLocalizedPost(publishedParent!, "ja")).resolves.toMatchObject({
      title: "公開翻訳",
      body: "公開本文",
    });

    await archivePost(original.id, { actor });
    await expect(getPublishedPostBySlug(original.slug)).resolves.toBeNull();
    await restorePost(original.id, { actor });
    await expect(getPublishedPostBySlug(original.slug)).resolves.toBeNull();
    const translations = await db
      .select()
      .from(postTranslations)
      .where(eq(postTranslations.postId, original.id));
    expect(translations).toHaveLength(2);
    expect(translations.find((row) => row.status === "published")?.title).toBe("公開翻訳");
  });

  it("keeps non-published parents out of public lists while preserving published permissions", async () => {
    const draft = await seedDraft({ title: "Draft" });
    const scheduled = await seedDraft({ title: "Scheduled" });
    await schedulePost(scheduled.id, { scheduledAt: await futureDate(), actor: adminActor() });
    const published = await seedDraft({ title: "Published" });
    await publishPostNow(published.id, { expectedState: "draft", actor: adminActor() });
    const archived = await seedDraft({ title: "Archived" });
    await publishPostNow(archived.id, { expectedState: "draft", actor: adminActor() });
    await archivePost(archived.id, { actor: adminActor() });

    const publicPosts = await listPosts({ publishedOnly: true });
    expect(publicPosts.map((post) => post.id)).toEqual([published.id]);
    expect(publicPosts.some((post) => post.id === draft.id)).toBe(false);
  });
});
