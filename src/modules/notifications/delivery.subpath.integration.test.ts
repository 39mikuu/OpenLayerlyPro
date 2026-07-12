import { randomUUID } from "crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// APP_URL carries a path prefix: every emailed link must keep it.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "notification-subpath-test-session-secret",
    APP_URL: "https://site.example/base",
    NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID: "supp-current",
    NOTIFICATION_SUPPRESSION_DIGEST_SECRET: "suppression-secret-0123456789012345",
    NOTIFICATION_UNSUBSCRIBE_KEY_ID: "unsub-current",
    NOTIFICATION_UNSUBSCRIBE_SECRET: "unsubscribe-secret-0123456789012345",
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
  notificationCampaigns,
  notificationDeliveries,
  notificationPreferences,
  posts,
  type Task,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { handleNotificationDeliveryTask } from "@/modules/notifications";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("notification delivery under an APP_URL path prefix", () => {
  const db = getDb();

  afterAll(async () => {
    await resetDatabase(db);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getSmtpConfig.mockResolvedValue({ configured: true });
    mocks.sendNewPostNotificationEmail.mockResolvedValue(undefined);
    await resetDatabase(db);
  });

  it("keeps the /base prefix on the post, confirm, and one-click URLs", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@example.test`, locale: "en" })
      .returning();
    if (!user) throw new Error("failed to seed user");
    await db.insert(notificationPreferences).values({ userId: user.id, newPostEmailEnabled: true });
    const [post] = await db
      .insert(posts)
      .values({
        title: "Subpath post",
        slug: `subpath-${randomUUID()}`,
        summary: "Summary",
        body: "Body",
        originalLocale: "zh",
        visibility: "public",
        status: "published",
        publishedAt: new Date(),
      })
      .returning();
    if (!post) throw new Error("failed to seed post");
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
    await db
      .insert(notificationDeliveries)
      .values({ campaignId: campaign.id, userId: user.id, taskId: task.id });

    await expect(handleNotificationDeliveryTask(task as Task)).resolves.toEqual({});

    expect(mocks.sendNewPostNotificationEmail).toHaveBeenCalledWith(
      user.email,
      expect.objectContaining({
        postUrl: `https://site.example/base/posts/${post.slug}`,
        unsubscribeConfirmUrl: expect.stringMatching(
          /^https:\/\/site\.example\/base\/unsubscribe\/notifications\/olp_npu\.v1\.unsub-current\./,
        ),
        unsubscribeOneClickUrl: expect.stringMatching(
          /^https:\/\/site\.example\/base\/api\/notifications\/unsubscribe\/olp_npu\.v1\.unsub-current\./,
        ),
      }),
      "en",
      {},
      expect.anything(),
    );
  });
});
