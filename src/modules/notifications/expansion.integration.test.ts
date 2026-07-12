import { randomUUID } from "crypto";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  memberships,
  membershipTiers,
  notificationCampaigns,
  notificationDeliveries,
  notificationPreferences,
  posts,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import {
  expansionRecipientQuery,
  handleCampaignExpandTask,
  handleCampaignFinalizeTask,
} from "@/modules/notifications";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type PlanNode = {
  "Node Type"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
};

type ExplainRow = {
  "QUERY PLAN": Array<{ Plan: PlanNode }>;
};

function walkPlan(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(walkPlan)];
}

function flattenPlanText(plan: PlanNode): string {
  return JSON.stringify(walkPlan(plan));
}

describeWithDatabase("notification campaign expansion", () => {
  const db = getDb();

  afterAll(async () => {
    await resetDatabase(db);
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function seedUser(
    id: string,
    input: { optIn?: boolean; role?: "admin" | "member" } = {},
  ): Promise<typeof users.$inferSelect> {
    const [user] = await db
      .insert(users)
      .values({
        id,
        email: `${id}@example.test`,
        role: input.role ?? "member",
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

  async function seedTier(level: number): Promise<typeof membershipTiers.$inferSelect> {
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: `Tier ${level}`,
        slug: `tier-${level}-${randomUUID()}`,
        priceLabel: `${level}`,
        level,
      })
      .returning();
    if (!tier) throw new Error("failed to seed tier");
    return tier;
  }

  async function seedMembership(
    userId: string,
    tierId: string,
    input: { status?: "active" | "suspended" | "revoked"; startsAt?: Date; endsAt?: Date } = {},
  ): Promise<void> {
    await db.insert(memberships).values({
      userId,
      tierId,
      source: "manual",
      startsAt: input.startsAt ?? new Date(Date.now() - 60_000),
      endsAt: input.endsAt ?? new Date(Date.now() + 60_000),
      status: input.status ?? "active",
    });
  }

  async function seedPost(
    input: { visibility?: "public" | "login" | "member"; requiredTierId?: string | null } = {},
  ): Promise<typeof posts.$inferSelect> {
    const [post] = await db
      .insert(posts)
      .values({
        title: "Expansion source",
        slug: `expansion-${randomUUID()}`,
        summary: "Expansion summary",
        body: "Expansion body",
        originalLocale: "zh",
        visibility: input.visibility ?? "public",
        requiredTierId: input.requiredTierId ?? null,
        status: "published",
        publishedAt: new Date(),
      })
      .returning();
    if (!post) throw new Error("failed to seed post");
    return post;
  }

  async function seedCampaign(
    postId: string,
    status: typeof notificationCampaigns.$inferSelect.status = "pending",
  ): Promise<typeof notificationCampaigns.$inferSelect> {
    const [campaign] = await db
      .insert(notificationCampaigns)
      .values({
        postId,
        status,
        source: "manual_publish",
        publishedAt: new Date(),
      })
      .returning();
    if (!campaign) throw new Error("failed to seed campaign");
    return campaign;
  }

  async function deliveryUserIds(campaignId: string): Promise<string[]> {
    const rows = await db
      .select({ userId: notificationDeliveries.userId })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.campaignId, campaignId))
      .orderBy(asc(notificationDeliveries.userId));
    return rows.map((row) => row.userId);
  }

  async function expand(campaignId: string) {
    return handleCampaignExpandTask({ version: 1, campaignId });
  }

  it("paginates expansion by user id and deduplicates by campaign/user", async () => {
    const userIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
    ];
    for (const userId of userIds) await seedUser(userId, { optIn: true });
    const post = await seedPost();
    const campaign = await seedCampaign(post.id);
    const expandWithSmallBatch = () =>
      handleCampaignExpandTask({ version: 1, campaignId: campaign.id }, { batchSize: 2 });

    await expect(expandWithSmallBatch()).resolves.toMatchObject({ deferUntil: expect.any(Date) });
    await expect(deliveryUserIds(campaign.id)).resolves.toEqual(userIds.slice(0, 2));
    await expect(expandWithSmallBatch()).resolves.toMatchObject({ deferUntil: expect.any(Date) });
    await expect(deliveryUserIds(campaign.id)).resolves.toEqual(userIds.slice(0, 4));
    await expect(expandWithSmallBatch()).resolves.toEqual({});
    await expect(deliveryUserIds(campaign.id)).resolves.toEqual(userIds);
    await expect(expandWithSmallBatch()).resolves.toEqual({});
    await expect(deliveryUserIds(campaign.id)).resolves.toEqual(userIds);

    const [stored] = await db
      .select()
      .from(notificationCampaigns)
      .where(eq(notificationCampaigns.id, campaign.id));
    expect(stored).toMatchObject({
      status: "sending",
      cursorUserId: userIds.at(-1),
    });
    expect(stored!.expansionCompletedAt).toBeInstanceOf(Date);

    // Tasks in one expansion batch share the transaction timestamp and ids
    // are pre-generated at random, so order by the payload user id instead.
    const deliveryTasks = (
      await db.select().from(tasks).where(eq(tasks.kind, "notification.deliver"))
    ).sort((a, b) =>
      String((a.payloadJson as { userId: string }).userId).localeCompare(
        String((b.payloadJson as { userId: string }).userId),
      ),
    );
    expect(deliveryTasks).toHaveLength(userIds.length);
    expect(deliveryTasks.map((task) => task.payloadJson)).toEqual(
      userIds.map((userId) => ({ version: 1, userId })),
    );
    for (const task of deliveryTasks) {
      expect(Object.keys(task.payloadJson as Record<string, unknown>).sort()).toEqual([
        "userId",
        "version",
      ]);
      expect(task).toMatchObject({ queueClass: "notification", priority: 90, maxAttempts: 5 });
    }
  });

  it("selects public and login recipients only by explicit opt-in, including admins", async () => {
    const optedIn = await seedUser("10000000-0000-4000-8000-000000000001", { optIn: true });
    await seedUser("10000000-0000-4000-8000-000000000002", { optIn: false });
    await seedUser("10000000-0000-4000-8000-000000000003");
    const admin = await seedUser("10000000-0000-4000-8000-000000000004", {
      optIn: true,
      role: "admin",
    });

    const publicPost = await seedPost({ visibility: "public" });
    const publicCampaign = await seedCampaign(publicPost.id);
    await expand(publicCampaign.id);
    await expect(deliveryUserIds(publicCampaign.id)).resolves.toEqual(
      [optedIn.id, admin.id].sort(),
    );

    const loginPost = await seedPost({ visibility: "login" });
    const loginCampaign = await seedCampaign(loginPost.id);
    await expand(loginCampaign.id);
    await expect(deliveryUserIds(loginCampaign.id)).resolves.toEqual([optedIn.id, admin.id].sort());
  });

  it("selects member recipients by effective active membership level without admin bypass", async () => {
    const lowTier = await seedTier(1);
    const requiredTier = await seedTier(2);
    const highTier = await seedTier(3);

    const activeRequired = await seedUser("20000000-0000-4000-8000-000000000001", { optIn: true });
    await seedMembership(activeRequired.id, requiredTier.id);

    const activeHigh = await seedUser("20000000-0000-4000-8000-000000000002", { optIn: true });
    await seedMembership(activeHigh.id, highTier.id);

    const activeLow = await seedUser("20000000-0000-4000-8000-000000000003", { optIn: true });
    await seedMembership(activeLow.id, lowTier.id);

    const suspendedHigh = await seedUser("20000000-0000-4000-8000-000000000004", { optIn: true });
    await seedMembership(suspendedHigh.id, highTier.id, { status: "suspended" });

    const expiredHigh = await seedUser("20000000-0000-4000-8000-000000000005", { optIn: true });
    await seedMembership(expiredHigh.id, highTier.id, {
      endsAt: new Date(Date.now() - 60_000),
    });

    const revokedHigh = await seedUser("20000000-0000-4000-8000-000000000006", { optIn: true });
    await seedMembership(revokedHigh.id, highTier.id, { status: "revoked" });

    const noPreference = await seedUser("20000000-0000-4000-8000-000000000007");
    await seedMembership(noPreference.id, highTier.id);

    const adminNoMembership = await seedUser("20000000-0000-4000-8000-000000000008", {
      optIn: true,
      role: "admin",
    });
    expect(adminNoMembership.role).toBe("admin");

    const post = await seedPost({ visibility: "member", requiredTierId: requiredTier.id });
    const campaign = await seedCampaign(post.id);
    await expand(campaign.id);

    await expect(deliveryUserIds(campaign.id)).resolves.toEqual(
      [activeRequired.id, activeHigh.id].sort(),
    );
  });

  it("marks campaigns completed when the post is no longer published before expansion", async () => {
    const post = await seedPost();
    const campaign = await seedCampaign(post.id);
    await db.update(posts).set({ status: "archived" }).where(eq(posts.id, post.id));

    await expect(expand(campaign.id)).resolves.toEqual({});
    const [stored] = await db
      .select()
      .from(notificationCampaigns)
      .where(eq(notificationCampaigns.id, campaign.id));
    expect(stored).toMatchObject({
      status: "completed",
      lastError: "post_not_published_before_expansion",
    });
    expect(stored!.completedAt).toBeInstanceOf(Date);
    await expect(db.select().from(notificationDeliveries)).resolves.toHaveLength(0);
  });

  it("finalizes only after expansion is complete and deliveries are terminal", async () => {
    const user = await seedUser("30000000-0000-4000-8000-000000000001", { optIn: true });
    const post = await seedPost();
    const campaign = await seedCampaign(post.id);
    const taskId = randomUUID();
    await db.insert(tasks).values({
      id: taskId,
      kind: "notification.deliver",
      dedupeKey: `notification:delivery:${randomUUID()}`,
      payloadJson: { version: 1, userId: user.id },
      queueClass: "notification",
      priority: 90,
    });
    await db.insert(notificationDeliveries).values({
      campaignId: campaign.id,
      userId: user.id,
      taskId,
    });

    await expect(
      handleCampaignFinalizeTask({ version: 1, campaignId: campaign.id }),
    ).resolves.toMatchObject({ deferUntil: expect.any(Date) });

    await db
      .update(notificationCampaigns)
      .set({ expansionCompletedAt: new Date(), status: "sending" })
      .where(eq(notificationCampaigns.id, campaign.id));
    await expect(
      handleCampaignFinalizeTask({ version: 1, campaignId: campaign.id }),
    ).resolves.toMatchObject({ deferUntil: expect.any(Date) });

    await db
      .update(notificationDeliveries)
      .set({ status: "accepted" })
      .where(eq(notificationDeliveries.campaignId, campaign.id));
    await expect(
      handleCampaignFinalizeTask({ version: 1, campaignId: campaign.id }),
    ).resolves.toEqual({});

    const [stored] = await db
      .select()
      .from(notificationCampaigns)
      .where(eq(notificationCampaigns.id, campaign.id));
    expect(stored).toMatchObject({ status: "completed" });
    expect(stored!.completedAt).toBeInstanceOf(Date);
  });

  it("uses a bounded indexed recipient expansion plan", async () => {
    const tier = await seedTier(5);
    const post = await seedPost({ visibility: "member", requiredTierId: tier.id });
    const campaign = await seedCampaign(post.id);
    await db.execute(sql`
      INSERT INTO users (id, email, role)
      SELECT gen_random_uuid(), 'future-' || gs::text || '@example.test', 'member'
      FROM generate_series(1, 2000) gs
    `);
    await db.execute(sql`
      INSERT INTO memberships (user_id, tier_id, source, status, starts_at, ends_at)
      SELECT id, ${tier.id}, 'manual', 'active', now() - interval '1 day', now() + interval '30 days'
      FROM users
    `);
    await db.execute(sql`
      INSERT INTO notification_preferences(user_id, new_post_email_enabled)
      SELECT id, true
      FROM users
    `);
    await db.execute(sql`analyze users`);
    await db.execute(sql`analyze notification_preferences`);
    await db.execute(sql`analyze memberships`);
    await db.execute(sql`analyze membership_tiers`);

    // EXPLAIN the actual production query shape, not a hand-written copy.
    const rows = await db.execute<ExplainRow>(sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
      ${expansionRecipientQuery({
        cursorUserId: campaign.cursorUserId,
        limit: 500,
        requiredTierLevel: tier.level,
      })}
    `);

    const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
    const nodes = walkPlan(plan);
    expect(nodes.some((node) => node["Node Type"] === "Limit")).toBe(true);
    expect(nodes.some((node) => node["Node Type"] === "Sort")).toBe(false);
    expect(flattenPlanText(plan)).toContain("notification_preferences");
    expect(flattenPlanText(plan)).toContain("memberships");
    expect(post.visibility).toBe("member");
  });
});
