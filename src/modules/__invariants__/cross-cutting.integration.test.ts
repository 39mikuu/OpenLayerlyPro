import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  files,
  memberships,
  membershipTiers,
  paymentRequests,
  postFiles,
  posts,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { executeScheduledPublish, getPublishedPostBySlug, schedulePost } from "@/modules/content";
import { canAccessFile } from "@/modules/download";
import { getActiveMembership } from "@/modules/membership";
import { approvePaymentRequest, reversePaymentApproval } from "@/modules/payment";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("cross-cutting core invariants", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seedMemberContent() {
    const [admin, fan] = await db
      .insert(users)
      .values([
        { email: `admin-${randomUUID()}@example.test`, role: "admin" },
        { email: `fan-${randomUUID()}@example.test` },
      ])
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
    const [post] = await db
      .insert(posts)
      .values({
        title: "Member post",
        slug: `member-post-${randomUUID()}`,
        visibility: "member",
        requiredTierId: tier!.id,
        status: "published",
        publishedAt: new Date(),
      })
      .returning();
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `content/${randomUUID()}`,
        originalName: "member.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        purpose: "content_attachment",
      })
      .returning();
    await db.insert(postFiles).values({
      postId: post!.id,
      fileId: file!.id,
      kind: "attachment",
    });
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: fan!.id,
        tierId: tier!.id,
        status: "pending_review",
        amountLabel: tier!.priceLabel,
        durationDays: tier!.durationDays,
      })
      .returning();
    return { admin: admin!, fan: fan!, file: file!, post: post!, request: request! };
  }

  it("connects payment review, membership access, outbox idempotency, and audit causality", async () => {
    const { admin, fan, file, request } = await seedMemberContent();

    await expect(getActiveMembership(fan.id)).resolves.toBeNull();
    await expect(canAccessFile(fan, file)).resolves.toMatchObject({ allowed: false });

    const approved = await approvePaymentRequest(request.id, admin.id);
    await expect(getActiveMembership(fan.id)).resolves.toMatchObject({
      membership: { id: approved.grantedMembershipId, status: "active" },
    });
    await expect(canAccessFile(fan, file)).resolves.toMatchObject({ allowed: true });

    await expect(approvePaymentRequest(request.id, admin.id)).rejects.toMatchObject({
      code: "paymentNotPending",
    });
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, fan.id)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(tasks)
        .where(eq(tasks.dedupeKey, `email:membership_activated:${request.id}`)),
    ).resolves.toHaveLength(1);

    const [approveAudit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, request.id), eq(auditEvents.action, "approve")));
    const [grantAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, approved.grantedMembershipId!),
          eq(auditEvents.action, "grant"),
        ),
      );
    expect(grantAudit).toMatchObject({
      correlationId: approveAudit?.correlationId,
      causationId: approveAudit?.id,
    });

    await reversePaymentApproval(request.id, admin.id, "duplicate transfer");
    await expect(getActiveMembership(fan.id)).resolves.toBeNull();
    await expect(canAccessFile(fan, file)).resolves.toMatchObject({ allowed: false });

    const [reverseAudit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, request.id), eq(auditEvents.action, "reverse")));
    const [revokeAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, approved.grantedMembershipId!),
          eq(auditEvents.action, "revoke"),
        ),
      );
    expect(revokeAudit).toMatchObject({
      correlationId: reverseAudit?.correlationId,
      causationId: reverseAudit?.id,
    });
  });

  it("keeps scheduled content and attachments private until the causal publish succeeds", async () => {
    const [post] = await db
      .insert(posts)
      .values({
        title: "Scheduled post",
        slug: `scheduled-${randomUUID()}`,
        visibility: "public",
        status: "draft",
      })
      .returning();
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `content/${randomUUID()}`,
        originalName: "scheduled.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        purpose: "content_attachment",
      })
      .returning();
    await db.insert(postFiles).values({
      postId: post!.id,
      fileId: file!.id,
      kind: "attachment",
    });
    const actor = { type: "admin" as const, id: randomUUID() };
    const scheduled = await schedulePost(post!.id, {
      scheduledAt: new Date(Date.now() + 60_000),
      actor,
    });
    const [task] = await db.select().from(tasks).where(eq(tasks.kind, "publish_post"));
    const payload = task!.payloadJson as {
      postId: string;
      scheduleToken: string;
      correlationId: string;
      schedulingAuditId: string;
    };

    await expect(getPublishedPostBySlug(post!.slug)).resolves.toBeNull();
    await expect(canAccessFile(null, file!)).resolves.toMatchObject({ allowed: false });

    await db
      .update(posts)
      .set({ scheduledAt: sql`now() - interval '1 second'` })
      .where(eq(posts.id, post!.id));
    await expect(executeScheduledPublish(payload)).resolves.toMatchObject({
      outcome: "published",
    });
    await expect(getPublishedPostBySlug(post!.slug)).resolves.not.toBeNull();
    await expect(canAccessFile(null, file!)).resolves.toMatchObject({
      allowed: true,
      postId: post!.id,
    });

    const [scheduleAudit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, post!.id), eq(auditEvents.action, "post.scheduled")));
    const [publishAudit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, post!.id), eq(auditEvents.action, "post.published")));
    expect(publishAudit).toMatchObject({
      correlationId: scheduleAudit?.correlationId,
      causationId: scheduleAudit?.id,
    });
    expect(scheduled.scheduleToken).toBe(payload.scheduleToken);
  });
});
