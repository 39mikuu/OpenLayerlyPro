import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  notificationCampaigns,
  notificationDeliveries,
  notificationDeliveryAttempts,
  notificationSuppressions,
  posts,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import {
  getNotificationCampaignAdminSummary,
  listNotificationCampaignAdminSummaries,
} from "./admin";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("notification admin summaries", () => {
  const db = getDb();

  afterAll(async () => {
    await resetDatabase(db);
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function seedCampaign(index: number) {
    const [post] = await db
      .insert(posts)
      .values({
        title: `Admin campaign ${index}`,
        slug: `admin-campaign-${index}-${randomUUID()}`,
        summary: "Admin campaign summary",
        body: "Admin campaign body",
        originalLocale: "zh",
        visibility: "public",
        status: "published",
        publishedAt: sql`now() - (${index} * interval '1 second')`,
      })
      .returning();
    if (!post) throw new Error("failed to seed post");

    const [campaign] = await db
      .insert(notificationCampaigns)
      .values({
        postId: post.id,
        source: "manual_publish",
        status: "sending",
        publishedAt: post.publishedAt ?? new Date(),
        expansionCompletedAt: new Date(),
        createdAt: sql`now() - (${index} * interval '1 second')`,
      })
      .returning();
    if (!campaign) throw new Error("failed to seed campaign");
    return { campaign, post };
  }

  async function seedDelivery(
    campaignId: string,
    status: "queued" | "sending" | "accepted" | "dead",
    outcome: "started" | "accepted" | "permanent_failure",
  ) {
    const [user] = await db
      .insert(users)
      .values({ email: `admin-${randomUUID()}@example.test` })
      .returning();
    if (!user) throw new Error("failed to seed user");

    const [task] = await db
      .insert(tasks)
      .values({
        kind: "notification.deliver",
        payloadJson: { version: 1, userId: user.id },
        queueClass: "notification",
      })
      .returning();
    if (!task) throw new Error("failed to seed task");

    const [delivery] = await db
      .insert(notificationDeliveries)
      .values({
        campaignId,
        userId: user.id,
        taskId: task.id,
        status,
        attemptCount: 1,
        lastOutcome: outcome,
      })
      .returning();
    if (!delivery) throw new Error("failed to seed delivery");

    await db.insert(notificationDeliveryAttempts).values({
      deliveryId: delivery.id,
      campaignId,
      userId: user.id,
      taskId: task.id,
      attemptNumber: 1,
      attemptUtcDay: new Date(),
      attemptMinute: new Date(),
      smtpAttempted: outcome !== "started",
      outcome,
      completedAt: outcome === "started" ? null : new Date(),
    });
    return delivery;
  }

  it("hydrates a bounded campaign list with set-based grouped counts", async () => {
    const campaigns = [];
    for (let index = 0; index < 55; index += 1) {
      campaigns.push(await seedCampaign(index));
    }
    const latest = campaigns[0]!.campaign;
    const second = campaigns[1]!.campaign;

    const accepted = await seedDelivery(latest.id, "accepted", "accepted");
    const dead = await seedDelivery(latest.id, "dead", "permanent_failure");
    await db.insert(notificationSuppressions).values({
      emailDigestKeyId: "supp-current",
      emailDigest: "a".repeat(64),
      reason: "smtp_permanent_5xx",
      firstDeliveryId: dead.id,
      lastDeliveryId: dead.id,
    });
    await db.insert(notificationSuppressions).values({
      emailDigestKeyId: "supp-current",
      emailDigest: "b".repeat(64),
      reason: "smtp_permanent_5xx",
      firstDeliveryId: accepted.id,
      lastDeliveryId: dead.id,
    });
    await seedDelivery(second.id, "sending", "started");

    const summaries = await listNotificationCampaignAdminSummaries();

    expect(summaries).toHaveLength(50);
    expect(summaries.map((summary) => summary.id)).not.toContain(campaigns[54]!.campaign.id);
    expect(summaries[0]).toMatchObject({
      id: latest.id,
      postTitle: campaigns[0]!.post.title,
      deliveryCounts: { accepted: 1, dead: 1 },
      attemptCounts: { accepted: 1, permanent_failure: 1 },
      suppressionCount: 2,
    });
    expect(summaries[1]).toMatchObject({
      id: second.id,
      deliveryCounts: { sending: 1 },
      attemptCounts: { started: 1 },
      suppressionCount: 0,
    });
  });

  it("hydrates one campaign summary with the same aggregate path", async () => {
    const { campaign } = await seedCampaign(0);
    await seedDelivery(campaign.id, "queued", "started");

    await expect(getNotificationCampaignAdminSummary(campaign.id)).resolves.toMatchObject({
      id: campaign.id,
      deliveryCounts: { queued: 1 },
      attemptCounts: { started: 1 },
      suppressionCount: 0,
    });
    await expect(getNotificationCampaignAdminSummary(randomUUID())).resolves.toBeNull();

    const [stored] = await db
      .select()
      .from(notificationCampaigns)
      .where(eq(notificationCampaigns.id, campaign.id));
    expect(stored).toBeDefined();
  });
});
