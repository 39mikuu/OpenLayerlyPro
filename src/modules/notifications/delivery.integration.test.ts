import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "notification-delivery-test-session-secret",
    APP_URL: "https://example.test",
    NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID: "supp-current",
    NOTIFICATION_SUPPRESSION_DIGEST_SECRET: "suppression-secret",
    NOTIFICATION_UNSUBSCRIBE_KEY_ID: "unsub-current",
    NOTIFICATION_UNSUBSCRIBE_SECRET: "unsubscribe-secret",
  });
});

const mocks = vi.hoisted(() => ({
  getSmtpConfig: vi.fn(),
  sendNewPostNotificationEmail: vi.fn(),
}));

vi.mock("@/modules/config", () => ({
  getSmtpConfig: mocks.getSmtpConfig,
}));

vi.mock("@/modules/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/mail")>();
  return {
    ...actual,
    sendNewPostNotificationEmail: mocks.sendNewPostNotificationEmail,
  };
});

import { getDb } from "@/db";
import {
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
  type Task,
  tasks,
  users,
} from "@/db/schema";
import { MailDeliveryError } from "@/modules/mail/delivery";
import { handleNotificationDeliveryTask } from "@/modules/notifications";
import { createNotificationSuppressionDigest } from "@/modules/security/notification-suppression-key";
import { PermanentTaskError } from "@/modules/tasks";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function utcMinuteStart(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
    ),
  );
}

describeWithDatabase("notification delivery", () => {
  const db = getDb();

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getSmtpConfig.mockResolvedValue({ configured: true });
    mocks.sendNewPostNotificationEmail.mockResolvedValue(undefined);

    await db.delete(notificationDeliveryAttempts);
    await db.delete(notificationDeliveries);
    await db.delete(notificationCampaigns);
    await db.delete(notificationPreferences);
    await db.delete(notificationQuotaWindows);
    await db.delete(notificationSuppressions);
    await db.delete(postTranslations);
    await db.delete(tasks);
    await db.delete(posts);
    await db.delete(memberships);
    await db.delete(membershipTiers);
    await db.delete(users);
  });

  async function seedUser(
    input: {
      email?: string;
      locale?: "zh" | "en" | "ja";
      optIn?: boolean;
    } = {},
  ) {
    const [user] = await db
      .insert(users)
      .values({
        email: input.email ?? `${randomUUID()}@example.test`,
        locale: input.locale ?? "en",
      })
      .returning();
    if (!user) throw new Error("failed to seed user");
    if (input.optIn !== undefined) {
      await db.insert(notificationPreferences).values({
        userId: user.id,
        newPostEmailEnabled: input.optIn,
      });
    }
    return user;
  }

  async function seedPost(
    input: {
      title?: string;
      summary?: string | null;
      locale?: string;
      visibility?: "public" | "login" | "member";
      status?: "draft" | "published" | "archived";
    } = {},
  ) {
    const [post] = await db
      .insert(posts)
      .values({
        title: input.title ?? "Original title",
        slug: `delivery-${randomUUID()}`,
        summary: input.summary ?? "Original summary",
        body: "Body",
        originalLocale: input.locale ?? "zh",
        visibility: input.visibility ?? "public",
        status: input.status ?? "published",
        publishedAt: input.status === "archived" ? null : new Date(),
      })
      .returning();
    if (!post) throw new Error("failed to seed post");
    return post;
  }

  async function seedDelivery(
    input: {
      user?: typeof users.$inferSelect;
      post?: typeof posts.$inferSelect;
      optIn?: boolean;
    } = {},
  ) {
    const user = input.user ?? (await seedUser({ optIn: input.optIn ?? true }));
    if (input.optIn !== undefined && input.user) {
      await db
        .insert(notificationPreferences)
        .values({ userId: user.id, newPostEmailEnabled: input.optIn })
        .onConflictDoUpdate({
          target: notificationPreferences.userId,
          set: { newPostEmailEnabled: input.optIn },
        });
    }
    const post = input.post ?? (await seedPost());
    const [campaign] = await db
      .insert(notificationCampaigns)
      .values({
        postId: post.id,
        source: "manual_publish",
        status: "sending",
        publishedAt: new Date(),
        expansionCompletedAt: new Date(),
      })
      .returning();
    if (!campaign) throw new Error("failed to seed campaign");

    const [task] = await db
      .insert(tasks)
      .values({
        kind: "notification.deliver",
        dedupeKey: `notification:delivery:${randomUUID()}`,
        payloadJson: { version: 1, userId: user.id },
        status: "processing",
        lockedBy: "worker",
        queueClass: "notification",
        priority: 90,
      })
      .returning();
    if (!task) throw new Error("failed to seed task");

    const [delivery] = await db
      .insert(notificationDeliveries)
      .values({
        campaignId: campaign.id,
        userId: user.id,
        taskId: task.id,
      })
      .returning();
    if (!delivery) throw new Error("failed to seed delivery");

    return { campaign, delivery, post, task: task as Task, user };
  }

  async function deliveryAttempts(deliveryId: string) {
    return db
      .select()
      .from(notificationDeliveryAttempts)
      .where(eq(notificationDeliveryAttempts.deliveryId, deliveryId))
      .orderBy(notificationDeliveryAttempts.attemptNumber);
  }

  it("renders the recipient locale translation and records accepted SMTP attempts", async () => {
    const user = await seedUser({ locale: "ja", optIn: true });
    const post = await seedPost({ title: "原文", summary: "原摘要", locale: "zh" });
    await db.insert(postTranslations).values({
      postId: post.id,
      locale: "ja",
      title: "日本語タイトル",
      summary: "日本語概要",
      status: "published",
    });
    const { delivery, task } = await seedDelivery({ user, post });

    await expect(handleNotificationDeliveryTask(task)).resolves.toEqual({});

    expect(mocks.sendNewPostNotificationEmail).toHaveBeenCalledWith(
      user.email,
      expect.objectContaining({
        title: "日本語タイトル",
        summary: "日本語概要",
        postUrl: `https://example.test/posts/${post.slug}`,
        unsubscribeUrl: expect.stringContaining(
          "https://example.test/api/notifications/unsubscribe/olp_npu.v1.unsub-current.",
        ),
      }),
      "ja",
      {},
      expect.objectContaining({
        category: "notification",
        campaignId: expect.any(String),
        deliveryId: delivery.id,
        recipientDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );

    const [stored] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    expect(stored).toMatchObject({ status: "accepted", attemptCount: 1, lastOutcome: "accepted" });
    const [attempt] = await deliveryAttempts(delivery.id);
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      smtpAttempted: true,
      outcome: "accepted",
      recipientLocale: "ja",
    });
    expect(JSON.stringify(attempt!.messageSnapshot)).not.toContain("日本語タイトル");
    expect(JSON.stringify(attempt!.messageSnapshot)).not.toContain("日本語概要");

    const quota = await db.select().from(notificationQuotaWindows);
    expect(quota.map((row) => [row.windowKind, row.attemptedCount]).sort()).toEqual([
      ["utc_day", 1],
      ["utc_minute", 1],
    ]);
  });

  it("skips disabled preferences before SMTP without consuming budget", async () => {
    const { delivery, task } = await seedDelivery({ optIn: false });

    await expect(handleNotificationDeliveryTask(task)).resolves.toEqual({});

    expect(mocks.sendNewPostNotificationEmail).not.toHaveBeenCalled();
    const [stored] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    expect(stored).toMatchObject({
      status: "skipped",
      attemptCount: 1,
      lastOutcome: "preference_disabled_skip",
    });
    const [attempt] = await deliveryAttempts(delivery.id);
    expect(attempt).toMatchObject({
      outcome: "preference_disabled_skip",
      smtpAttempted: false,
    });
    await expect(db.select().from(notificationQuotaWindows)).resolves.toHaveLength(0);
  });

  it("defers daily budget exhaustion without SMTP or duplicate quota consumption", async () => {
    const now = new Date();
    await db.insert(notificationQuotaWindows).values([
      { windowKind: "utc_day", windowStart: utcDayStart(now), attemptedCount: 500 },
      { windowKind: "utc_minute", windowStart: utcMinuteStart(now), attemptedCount: 0 },
    ]);
    const { delivery, task } = await seedDelivery();

    await expect(handleNotificationDeliveryTask(task)).resolves.toMatchObject({
      deferUntil: expect.any(Date),
    });

    expect(mocks.sendNewPostNotificationEmail).not.toHaveBeenCalled();
    const [stored] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    expect(stored).toMatchObject({
      status: "deferred",
      attemptCount: 1,
      lastOutcome: "budget_defer",
    });
    const quota = await db.select().from(notificationQuotaWindows);
    expect(quota.find((row) => row.windowKind === "utc_day")?.attemptedCount).toBe(500);
    expect(quota.find((row) => row.windowKind === "utc_minute")?.attemptedCount).toBe(0);
    const [attempt] = await deliveryAttempts(delivery.id);
    expect(attempt).toMatchObject({ outcome: "budget_defer", smtpAttempted: false });
  });

  it("uses quota row locks as a concurrent minute pacing fence", async () => {
    const now = new Date();
    await db.insert(notificationQuotaWindows).values([
      { windowKind: "utc_day", windowStart: utcDayStart(now), attemptedCount: 0 },
      { windowKind: "utc_minute", windowStart: utcMinuteStart(now), attemptedCount: 29 },
    ]);
    const first = await seedDelivery();
    const second = await seedDelivery();

    await Promise.all([
      handleNotificationDeliveryTask(first.task),
      handleNotificationDeliveryTask(second.task),
    ]);

    const attempts = await db.select().from(notificationDeliveryAttempts);
    expect(attempts.map((attempt) => attempt.outcome).sort()).toEqual(["accepted", "pacing_defer"]);
    expect(attempts.filter((attempt) => attempt.smtpAttempted)).toHaveLength(1);
    const minute = (
      await db
        .select()
        .from(notificationQuotaWindows)
        .where(eq(notificationQuotaWindows.windowKind, "utc_minute"))
    )[0];
    expect(minute?.attemptedCount).toBe(30);
  });

  it("upserts suppression and dead-letters permanent SMTP failures", async () => {
    mocks.sendNewPostNotificationEmail.mockRejectedValue(new MailDeliveryError("permanent"));
    const { delivery, task, user } = await seedDelivery();

    await expect(handleNotificationDeliveryTask(task)).rejects.toMatchObject({
      message: "Notification email delivery failed permanently",
      classification: "permanent",
    } satisfies Partial<PermanentTaskError>);

    const [stored] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    expect(stored).toMatchObject({ status: "dead", lastOutcome: "permanent_failure" });
    const [attempt] = await deliveryAttempts(delivery.id);
    expect(attempt).toMatchObject({ outcome: "permanent_failure", smtpAttempted: true });
    const digest = createNotificationSuppressionDigest(user.email);
    const [suppression] = await db
      .select()
      .from(notificationSuppressions)
      .where(eq(notificationSuppressions.emailDigest, digest.digest));
    expect(suppression).toMatchObject({
      emailDigestKeyId: "supp-current",
      firstDeliveryId: delivery.id,
      lastDeliveryId: delivery.id,
    });
  });

  it("keeps transient SMTP failures retryable with a failed delivery status", async () => {
    mocks.sendNewPostNotificationEmail.mockRejectedValue(new MailDeliveryError("transient"));
    const { delivery, task } = await seedDelivery();

    await expect(handleNotificationDeliveryTask(task)).rejects.toMatchObject({
      name: "MailDeliveryError",
      kind: "transient",
    });

    const [stored] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    expect(stored).toMatchObject({ status: "failed", lastOutcome: "transient_failure" });
    const [attempt] = await deliveryAttempts(delivery.id);
    expect(attempt).toMatchObject({ outcome: "transient_failure", smtpAttempted: true });
  });

  it("defers missing SMTP configuration without consuming notification budget", async () => {
    mocks.getSmtpConfig.mockResolvedValue({ configured: false });
    const { delivery, task } = await seedDelivery();

    await expect(handleNotificationDeliveryTask(task)).resolves.toMatchObject({
      deferUntil: expect.any(Date),
    });

    expect(mocks.sendNewPostNotificationEmail).not.toHaveBeenCalled();
    const [stored] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    expect(stored).toMatchObject({ status: "deferred", lastOutcome: "needs_operator_defer" });
    const [attempt] = await deliveryAttempts(delivery.id);
    expect(attempt).toMatchObject({ outcome: "needs_operator_defer", smtpAttempted: false });
    await expect(db.select().from(notificationQuotaWindows)).resolves.toHaveLength(0);
  });

  it("suppression skips notification sends but does not affect transactional mail", async () => {
    const user = await seedUser({ optIn: true });
    const digest = createNotificationSuppressionDigest(user.email);
    await db.insert(notificationSuppressions).values({
      emailDigestKeyId: digest.keyId,
      emailDigest: digest.digest,
      reason: "smtp_permanent_5xx",
    });
    const { delivery, task } = await seedDelivery({ user });

    await expect(handleNotificationDeliveryTask(task)).resolves.toEqual({});

    expect(mocks.sendNewPostNotificationEmail).not.toHaveBeenCalled();
    const [stored] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    expect(stored).toMatchObject({ status: "suppressed", lastOutcome: "suppressed_skip" });
  });

  it("can retry after an accepted SMTP send crashes before finalization", async () => {
    const first = await seedDelivery();
    mocks.sendNewPostNotificationEmail.mockResolvedValueOnce(undefined);
    await db
      .update(tasks)
      .set({ status: "processing", leaseUntil: sql`now() - interval '1 minute'` })
      .where(eq(tasks.id, first.task.id));

    const acceptedSend = handleNotificationDeliveryTask(first.task);
    await expect(acceptedSend).resolves.toEqual({});

    await db
      .update(notificationDeliveries)
      .set({ status: "failed", lastOutcome: "transient_failure" })
      .where(eq(notificationDeliveries.id, first.delivery.id));
    await db
      .update(tasks)
      .set({
        status: "processing",
        lockedBy: "worker-2",
        leaseUntil: sql`now() + interval '1 minute'`,
      })
      .where(eq(tasks.id, first.task.id));
    const [retryTask] = await db.select().from(tasks).where(eq(tasks.id, first.task.id));
    if (!retryTask) throw new Error("retry task missing");

    await expect(handleNotificationDeliveryTask(retryTask as Task)).resolves.toEqual({});

    const attempts = await deliveryAttempts(first.delivery.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(mocks.sendNewPostNotificationEmail).toHaveBeenCalledTimes(2);
  });
});
