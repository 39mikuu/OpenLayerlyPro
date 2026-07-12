import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  memberships,
  membershipTiers,
  notificationCampaigns,
  notificationDeliveries,
  notificationDeliveryAttempts,
  notificationPreferences,
  notificationQuotaWindows,
  notificationSuppressions,
  posts,
  postTranslations,
  tasks,
  users,
} from "@/db/schema";
import { recordAudit } from "@/modules/audit";
import {
  archivePost,
  cancelPostSchedule,
  executeScheduledPublish,
  publishPostNow,
  reschedulePost,
  restorePost,
  schedulePost,
} from "@/modules/content";
import { createCampaignForPublishedPostTx } from "@/modules/notifications";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type PublishTaskPayload = {
  postId: string;
  scheduleToken: string;
  correlationId: string;
  schedulingAuditId: string;
};

const adminActor = () => ({ type: "admin" as const, id: randomUUID() });

describeWithDatabase("notification campaign creation", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(notificationDeliveryAttempts);
    await db.delete(notificationDeliveries);
    await db.delete(notificationCampaigns);
    await db.delete(notificationPreferences);
    await db.delete(notificationQuotaWindows);
    await db.delete(notificationSuppressions);
    await db.delete(postTranslations);
    await db.delete(auditEvents);
    await db.delete(tasks);
    await db.delete(posts);
    await db.delete(memberships);
    await db.delete(membershipTiers);
    await db.delete(users);
  });

  async function seedDraft(): Promise<typeof posts.$inferSelect> {
    const [post] = await db
      .insert(posts)
      .values({
        title: "Campaign source",
        slug: `campaign-${randomUUID()}`,
        summary: "Campaign summary",
        body: "Campaign body",
        originalLocale: "zh",
        visibility: "public",
        status: "draft",
      })
      .returning();
    if (!post) throw new Error("failed to seed post");
    return post;
  }

  async function scheduleDuePost(postId: string): Promise<PublishTaskPayload> {
    await schedulePost(postId, { scheduledAt: new Date(Date.now() + 60_000), actor: adminActor() });
    const queued = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "publish_post"))
      .orderBy(tasks.createdAt);
    const task = queued.find(
      (row) =>
        typeof row.payloadJson === "object" &&
        row.payloadJson !== null &&
        (row.payloadJson as { postId?: unknown }).postId === postId,
    );
    if (!task || typeof task.payloadJson !== "object" || task.payloadJson === null) {
      throw new Error("publish task missing");
    }
    await db
      .update(posts)
      .set({ scheduledAt: sql`now() - interval '1 second'` })
      .where(eq(posts.id, postId));
    return task.payloadJson as PublishTaskPayload;
  }

  async function campaignRows() {
    return db.select().from(notificationCampaigns).orderBy(notificationCampaigns.createdAt);
  }

  async function taskRows() {
    return db.select().from(tasks).orderBy(tasks.createdAt);
  }

  it("creates a manual publish campaign and expansion task in the publish transaction", async () => {
    const post = await seedDraft();

    await publishPostNow(post.id, { expectedState: "draft", actor: adminActor() });

    const campaigns = await campaignRows();
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toMatchObject({
      postId: post.id,
      source: "manual_publish",
      status: "pending",
    });
    expect(campaigns[0]!.publishedAt).toBeInstanceOf(Date);

    const notificationTasks = (await taskRows()).filter(
      (task) => task.kind === "notification.campaign_expand",
    );
    expect(notificationTasks).toHaveLength(1);
    expect(notificationTasks[0]).toMatchObject({
      dedupeKey: `notification:campaign_expand:${campaigns[0]!.id}`,
      queueClass: "notification",
      priority: 80,
      payloadJson: { version: 1, campaignId: campaigns[0]!.id },
    });
  });

  it("rolls back post, audit, campaign, and expansion task when campaign creation fails", async () => {
    const post = await seedDraft();

    await expect(
      publishPostNow(
        post.id,
        { expectedState: "draft", actor: adminActor() },
        {
          createCampaign: async (tx, input) => {
            await createCampaignForPublishedPostTx(tx, input);
            throw new Error("forced campaign failure");
          },
        },
      ),
    ).rejects.toThrow("forced campaign failure");

    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
    await expect(db.select().from(notificationCampaigns)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
    const [stored] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(stored).toMatchObject({ status: "draft", publishedAt: null });
  });

  it("creates only one campaign per post across scheduled publish replay and manual republish", async () => {
    const post = await seedDraft();
    const payload = await scheduleDuePost(post.id);

    await expect(executeScheduledPublish(payload)).resolves.toMatchObject({ outcome: "published" });
    await expect(executeScheduledPublish(payload)).resolves.toMatchObject({ outcome: "noop" });

    const campaignsAfterScheduledPublish = await campaignRows();
    expect(campaignsAfterScheduledPublish).toHaveLength(1);
    expect(campaignsAfterScheduledPublish[0]).toMatchObject({
      postId: post.id,
      source: "scheduled_publish",
    });

    await archivePost(post.id, { actor: adminActor() });
    await restorePost(post.id, { actor: adminActor() });
    await publishPostNow(post.id, { expectedState: "draft", actor: adminActor() });

    const campaignsAfterRepublish = await campaignRows();
    expect(campaignsAfterRepublish).toHaveLength(1);
    expect(campaignsAfterRepublish[0]!.id).toBe(campaignsAfterScheduledPublish[0]!.id);
    expect(
      (await taskRows()).filter((task) => task.kind === "notification.campaign_expand"),
    ).toHaveLength(1);
  });

  it("does not create campaigns for schedule cancellation or stale scheduled tasks", async () => {
    const cancelledPost = await seedDraft();
    await schedulePost(cancelledPost.id, {
      scheduledAt: new Date(Date.now() + 60_000),
      actor: adminActor(),
    });
    const [cancelledTask] = await db.select().from(tasks).where(eq(tasks.kind, "publish_post"));
    await cancelPostSchedule(cancelledPost.id, {
      expectedScheduleToken: (cancelledTask!.payloadJson as PublishTaskPayload).scheduleToken,
      actor: adminActor(),
    });
    await expect(
      executeScheduledPublish(cancelledTask!.payloadJson as PublishTaskPayload),
    ).resolves.toMatchObject({ outcome: "noop" });

    const stalePost = await seedDraft();
    const oldPayload = await scheduleDuePost(stalePost.id);
    await reschedulePost(stalePost.id, {
      scheduledAt: new Date(Date.now() + 120_000),
      expectedScheduleToken: oldPayload.scheduleToken,
      actor: adminActor(),
    });
    await expect(executeScheduledPublish(oldPayload)).resolves.toMatchObject({ outcome: "noop" });

    await expect(db.select().from(notificationCampaigns)).resolves.toHaveLength(0);
    await expect(
      db.select().from(tasks).where(eq(tasks.kind, "notification.campaign_expand")),
    ).resolves.toHaveLength(0);
  });

  it("leaves archive and restore paths notification-free", async () => {
    const post = await seedDraft();
    await publishPostNow(post.id, { expectedState: "draft", actor: adminActor() });
    await db.delete(tasks).where(eq(tasks.kind, "notification.campaign_expand"));

    await archivePost(post.id, { actor: adminActor() });
    await restorePost(post.id, { actor: adminActor() });

    const campaigns = await campaignRows();
    expect(campaigns).toHaveLength(1);
    await expect(
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.kind, "notification.campaign_expand"), eq(tasks.status, "pending"))),
    ).resolves.toHaveLength(0);
  });

  it("uses the default audit and task dependencies when tests override only campaign creation", async () => {
    const post = await seedDraft();
    await publishPostNow(
      post.id,
      { expectedState: "draft", actor: adminActor() },
      { audit: recordAudit },
    );

    await expect(db.select().from(notificationCampaigns)).resolves.toHaveLength(1);
    await expect(
      db.select().from(tasks).where(eq(tasks.kind, "notification.campaign_expand")),
    ).resolves.toHaveLength(1);
  });
});
