import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  memberships,
  membershipTiers,
  paymentRequests,
  siteSettings,
  supporterWallEntries,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { approvePaymentRequest, reversePaymentApproval } from "@/modules/payment";

import {
  applySupporterWallSettingsUpdate,
  approveSupporterWallEntry,
  buildAdminSupporterWallPageQuery,
  buildPublicSupporterWallQuery,
  getMyWallEntry,
  getSupporterWallSettings,
  getSupporterWallViewModel,
  hideSupporterWallEntry,
  listSupporterWallEntriesPage,
  optOut,
  updateUserDisplayNameWithWallReset,
  upsertOptIn,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type PlanNode = {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
};

type ExplainRow = {
  "QUERY PLAN": Array<{ Plan: PlanNode }>;
};

function walkPlan(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(walkPlan)];
}

function findPlanPath(plan: PlanNode, predicate: (node: PlanNode) => boolean): PlanNode[] | null {
  if (predicate(plan)) return [plan];
  for (const child of plan.Plans ?? []) {
    const path = findPlanPath(child, predicate);
    if (path) return [plan, ...path];
  }
  return null;
}

function actualRowsAcrossLoops(node: PlanNode): number {
  return Number(node["Actual Rows"] ?? 0) * Number(node["Actual Loops"] ?? 0);
}

function actualTupleVisitsAcrossLoops(node: PlanNode): number {
  const rowsPerLoop =
    Number(node["Actual Rows"] ?? 0) +
    Number(node["Rows Removed by Filter"] ?? 0) +
    Number(node["Rows Removed by Index Recheck"] ?? 0);
  return rowsPerLoop * Number(node["Actual Loops"] ?? 0);
}

// Drizzle wraps database errors ("Failed query: ..."), so assertions about
// the underlying failure must look down the cause chain.
function flattenErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { code?: string }).code;
    parts.push(`${code ?? ""} ${current.message}`);
    current = current.cause;
  }
  return parts.join(" | ");
}

describeWithDatabase("supporter wall domain integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function seedUser(displayName: string | null = "Public Fan") {
    const [user] = await db
      .insert(users)
      .values({ email: `supporter-${randomUUID()}@example.test`, displayName })
      .returning();
    return user!;
  }

  async function seedAdmin() {
    const [admin] = await db
      .insert(users)
      .values({ email: `admin-${randomUUID()}@example.test`, role: "admin" })
      .returning();
    return admin!;
  }

  async function seedTier(level: number, name = `Tier ${level}`, isActive = true) {
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name,
        slug: `tier-${level}-${randomUUID()}`,
        priceLabel: `${level * 100}`,
        level,
        isActive,
      })
      .returning();
    return tier!;
  }

  async function seedMembership(userId: string, tierId: string, status = "active") {
    const [membership] = await db
      .insert(memberships)
      .values({
        userId,
        tierId,
        source: "manual",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: status as "active" | "suspended" | "revoked",
      })
      .returning();
    return membership!;
  }

  async function enableWall(minLevel: number | null = null) {
    const admin = await seedAdmin();
    await applySupporterWallSettingsUpdate({
      enabled: true,
      minLevel,
      actor: { type: "admin", id: admin.id },
    });
    return admin;
  }

  async function createApprovedSupporter(options: {
    displayName: string;
    dedication?: string | null;
    level?: number;
    tierName?: string;
    tierActive?: boolean;
  }) {
    const admin = await seedAdmin();
    const user = await seedUser(options.displayName);
    const tier = await seedTier(options.level ?? 10, options.tierName, options.tierActive);
    const membership = await seedMembership(user.id, tier.id);
    const entry = await upsertOptIn({ userId: user.id, dedication: options.dedication ?? null });
    const approved = await approveSupporterWallEntry({
      id: entry.id,
      expectedVersion: entry.version,
      actor: { type: "admin", id: admin.id },
    });
    return { admin, approved, entry, membership, tier, user };
  }

  // upsertOptIn locks the user row up front, so concurrent service calls
  // serialize on that lock and the second call sees the first call's row.
  // This covers the service path; the constraint race itself is exercised by
  // the raw-transaction test below, which bypasses the row lock.
  it("serializes concurrent fan opt-ins on the user row lock", async () => {
    const user = await seedUser("Concurrent Fan");

    const [first, second] = await Promise.all([
      upsertOptIn({ userId: user.id, dedication: "first" }),
      upsertOptIn({ userId: user.id, dedication: "second" }),
    ]);

    const rows = await db
      .select()
      .from(supporterWallEntries)
      .where(eq(supporterWallEntries.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect(rows[0]).toMatchObject({ userId: user.id, status: "pending" });
    expect(["first", "second"]).toContain(rows[0]!.dedication);
  });

  it("lets the user_id unique constraint win a true concurrent insert race", async () => {
    const user = await seedUser("Race Fan");

    // Two raw transactions insert for the same user with neither committed:
    // no application lock is involved, so only the database constraint can
    // prevent a duplicate entry.
    let firstInserted!: () => void;
    const firstInsertedGate = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    let commitFirst!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      commitFirst = resolve;
    });

    const first = db.transaction(async (tx) => {
      await tx
        .insert(supporterWallEntries)
        .values({ userId: user.id, dedication: "first", status: "pending" });
      firstInserted();
      await commitGate;
    });
    await firstInsertedGate;

    // This insert blocks inside PostgreSQL on the uncommitted unique-index
    // entry until the first transaction commits, then raises 23505.
    const second = db
      .transaction(async (tx) => {
        await tx
          .insert(supporterWallEntries)
          .values({ userId: user.id, dedication: "second", status: "pending" });
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
    commitFirst();
    await first;
    const raceError = await second;

    expect(raceError).toBeInstanceOf(Error);
    expect(flattenErrorChain(raceError)).toMatch(/23505|duplicate key/i);
    const rows = await db
      .select()
      .from(supporterWallEntries)
      .where(eq(supporterWallEntries.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedication).toBe("first");
  });

  it("rejects stale versioned moderation without double-applying audit", async () => {
    const admin = await seedAdmin();
    const user = await seedUser("Moderation Fan");
    const entry = await upsertOptIn({ userId: user.id, dedication: "looks good" });

    const approved = await approveSupporterWallEntry({
      id: entry.id,
      expectedVersion: 0,
      actor: { type: "admin", id: admin.id },
    });
    await expect(
      hideSupporterWallEntry({
        id: entry.id,
        expectedVersion: 0,
        actor: { type: "admin", id: admin.id },
      }),
    ).rejects.toMatchObject({ status: 409, code: "supporterWallEntryStale" });

    const [stored] = await db
      .select()
      .from(supporterWallEntries)
      .where(eq(supporterWallEntries.id, entry.id));
    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, entry.id));
    expect(approved).toMatchObject({ status: "approved", version: 1 });
    expect(stored).toMatchObject({ status: "approved", version: 1 });
    expect(events.map((event) => event.action)).toEqual(["approve"]);
  });

  it("delists approved supporters on expiry, suspension, revocation, and payment reversal", async () => {
    const admin = await enableWall();
    const expired = await createApprovedSupporter({ displayName: "Expired Fan", level: 10 });
    const suspended = await createApprovedSupporter({ displayName: "Suspended Fan", level: 10 });
    const revoked = await createApprovedSupporter({ displayName: "Revoked Fan", level: 10 });

    const reversedUser = await seedUser("Reversed Fan");
    const reversedTier = await seedTier(10, "Reversed Tier");
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: reversedUser.id,
        tierId: reversedTier.id,
        status: "pending_review",
        amountLabel: reversedTier.priceLabel,
        durationDays: reversedTier.durationDays,
      })
      .returning();
    await approvePaymentRequest(request!.id, admin.id);
    const reversedEntry = await upsertOptIn({ userId: reversedUser.id, dedication: "reversed" });
    await approveSupporterWallEntry({
      id: reversedEntry.id,
      expectedVersion: reversedEntry.version,
      actor: { type: "admin", id: admin.id },
    });

    await expect(getSupporterWallViewModel()).resolves.toMatchObject({
      supporters: expect.arrayContaining([
        expect.objectContaining({ displayName: "Expired Fan" }),
        expect.objectContaining({ displayName: "Suspended Fan" }),
        expect.objectContaining({ displayName: "Revoked Fan" }),
        expect.objectContaining({ displayName: "Reversed Fan" }),
      ]),
    });

    await db
      .update(memberships)
      .set({ endsAt: new Date(Date.now() - 60_000) })
      .where(eq(memberships.id, expired.membership.id));
    await db
      .update(memberships)
      .set({ status: "suspended" })
      .where(eq(memberships.id, suspended.membership.id));
    await db
      .update(memberships)
      .set({ status: "revoked" })
      .where(eq(memberships.id, revoked.membership.id));
    await reversePaymentApproval(request!.id, admin.id, "supporter wall reversal test");

    const viewModel = await getSupporterWallViewModel();
    const publicNames = viewModel?.supporters.map((supporter) => supporter.displayName) ?? [];
    for (const delistedName of ["Expired Fan", "Suspended Fan", "Revoked Fan", "Reversed Fan"]) {
      expect(publicNames).not.toContain(delistedName);
    }
  });

  it("applies feature toggle, threshold, overlap max-level, and discontinued-tier semantics", async () => {
    await expect(getSupporterWallViewModel()).resolves.toBeNull();
    const admin = await enableWall(10);
    const low = await createApprovedSupporter({ displayName: "Low Fan", level: 5 });
    const high = await createApprovedSupporter({
      displayName: "High Fan",
      level: 10,
      tierName: "Discontinued Gold",
      tierActive: false,
    });
    await seedMembership(high.user.id, low.tier.id);

    await expect(getSupporterWallViewModel()).resolves.toMatchObject({
      supporters: [{ displayName: "High Fan", tierName: "Discontinued Gold" }],
    });

    await applySupporterWallSettingsUpdate({
      enabled: true,
      minLevel: null,
      actor: { type: "admin", id: admin.id },
    });
    await expect(getSupporterWallViewModel()).resolves.toMatchObject({
      supporters: expect.arrayContaining([
        expect.objectContaining({ displayName: "High Fan" }),
        expect.objectContaining({ displayName: "Low Fan" }),
      ]),
    });

    await db
      .update(siteSettings)
      .set({ valueJson: "not-a-level" })
      .where(eq(siteSettings.key, "supporterWallMinLevel"));
    await expect(getSupporterWallViewModel()).resolves.toBeNull();

    await applySupporterWallSettingsUpdate({
      enabled: false,
      minLevel: null,
      actor: { type: "admin", id: admin.id },
    });
    await expect(getSupporterWallViewModel()).resolves.toBeNull();
  });

  it("rejects minLevel outside int4 and degrades safely if one is already stored", async () => {
    const admin = await enableWall();
    await createApprovedSupporter({ displayName: "Int4 Fan", level: 10 });

    // The public query compares minLevel against membership_tiers.level
    // (int4); values beyond int4 max must be rejected before they are stored.
    await expect(
      applySupporterWallSettingsUpdate({
        enabled: true,
        minLevel: 2147483648,
        actor: { type: "admin", id: admin.id },
      }),
    ).rejects.toMatchObject({ status: 400, code: "supporterWallInvalidMinLevel" });
    await expect(getSupporterWallViewModel()).resolves.toMatchObject({
      supporters: [expect.objectContaining({ displayName: "Int4 Fan" })],
    });

    // A value written behind the API's back must hide the wall instead of
    // making every public read fail at bind time.
    await db
      .update(siteSettings)
      .set({ valueJson: 2147483648 })
      .where(eq(siteSettings.key, "supporterWallMinLevel"));
    await expect(getSupporterWallViewModel()).resolves.toBeNull();
  });

  it("derives the latest 200 approved candidates in deterministic creation order", async () => {
    await enableWall();
    const tier = await seedTier(10, "Public Wall Tier");
    const now = Date.now();
    const population = Array.from({ length: 201 }, (_, index) => ({
      id: randomUUID(),
      email: `ordered-${index}-${randomUUID()}@example.test`,
      displayName: `Ordered Fan ${index.toString().padStart(3, "0")}`,
    }));
    await db.insert(users).values(population);
    await db.insert(memberships).values(
      population.map((user) => ({
        userId: user.id,
        tierId: tier.id,
        source: "manual" as const,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "active" as const,
      })),
    );
    await db.insert(supporterWallEntries).values(
      population.map((user, index) => ({
        userId: user.id,
        dedication: null,
        status: "approved" as const,
        createdAt: new Date(now - (population.length - index) * 1_000),
        updatedAt: new Date(now - (population.length - index) * 1_000),
      })),
    );

    const viewModel = await getSupporterWallViewModel();

    expect(viewModel?.supporters).toHaveLength(200);
    expect(viewModel?.supporters.map((supporter) => supporter.displayName)).toEqual(
      population.slice(1).map((user) => user.displayName),
    );
  });

  it("bounds public entry and membership work when the newest candidates are ineligible", async () => {
    const tier = await seedTier(10, "Plan Shape Tier");
    const now = Date.now();
    const membershipsPerUser = 3;
    const population = await db
      .insert(users)
      .values(
        Array.from({ length: 250 }, (_, index) => ({
          email: `plan-shape-${index}-${randomUUID()}@example.test`,
          displayName: `Plan Shape Fan ${index.toString().padStart(3, "0")}`,
        })),
      )
      .returning({ id: users.id });

    // Only the oldest 50 entries qualify. The latest 200 approved candidates
    // all have revoked memberships, so an eligibility-driven outer LIMIT
    // would scan/probe all 250 rows trying to fill its result. The candidate
    // boundary must stop after the newest 200 regardless of eligibility.
    await db.insert(memberships).values(
      population.flatMap((user, index) =>
        Array.from({ length: membershipsPerUser }, (_, slot) => ({
          userId: user.id,
          tierId: tier.id,
          source: "manual" as const,
          startsAt: new Date(now - 60_000),
          endsAt: new Date(now + 24 * 60 * 60 * 1000 + index * 10 + slot),
          status: index < 50 ? ("active" as const) : ("revoked" as const),
        })),
      ),
    );
    await db.insert(supporterWallEntries).values(
      population.map((user, index) => ({
        userId: user.id,
        dedication: null,
        status: "approved" as const,
        createdAt: new Date(now - (population.length - index) * 1_000),
        updatedAt: new Date(now - (population.length - index) * 1_000),
      })),
    );

    await db.execute(sql`analyze users`);
    await db.execute(sql`analyze membership_tiers`);
    await db.execute(sql`analyze memberships`);
    await db.execute(sql`analyze supporter_wall_entries`);

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const publicQuery = buildPublicSupporterWallQuery(null);
      const rows = await tx.execute<ExplainRow>(
        sql`explain (analyze, format json, costs off, timing off, summary off) ${publicQuery}`,
      );
      const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
      const nodes = walkPlan(plan);
      expect(actualRowsAcrossLoops(plan)).toBe(0);
      const entryAccessPath = findPlanPath(
        plan,
        (node) => node["Index Name"] === "supporter_wall_entries_status_created_id_idx",
      );
      const membershipAccessNodes = nodes.filter((node) => node["Relation Name"] === "memberships");
      const membershipUserIndexNodes = nodes.filter(
        (node) => node["Index Name"] === "memberships_user_active_idx",
      );
      const userAccessNodes = nodes.filter((node) => node["Relation Name"] === "users");

      // The candidate Limit must consume the newest approved entries directly
      // from the (status, created_at, id) index. An outer Sort is allowed only
      // after this boundary, where it can order at most 200 rows for display.
      expect(entryAccessPath).not.toBeNull();
      const candidateLimitIndex = entryAccessPath!.findIndex(
        (node) => node["Node Type"] === "Limit",
      );
      expect(candidateLimitIndex).toBeGreaterThanOrEqual(0);
      for (const node of entryAccessPath!.slice(candidateLimitIndex + 1)) {
        expect(node["Node Type"]).not.toBe("Sort");
      }
      const entryAccess = entryAccessPath!.at(-1)!;
      const entryRowsVisited = actualRowsAcrossLoops(entryAccess);
      expect(entryRowsVisited).toBe(200);
      expect(entryRowsVisited).toBeLessThan(population.length);
      expect(nodes.some((node) => node["Index Name"] === "users_pkey")).toBe(true);
      expect(userAccessNodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(false);
      const userProbeLoops = userAccessNodes.reduce(
        (total, node) => total + Number(node["Actual Loops"] ?? 0),
        0,
      );
      const userTupleVisits = userAccessNodes.reduce(
        (total, node) => total + actualTupleVisitsAcrossLoops(node),
        0,
      );
      // A membership-first plan may never execute the user lookup when all
      // candidates are ineligible, hence zero is valid; a global users index
      // scan would still exceed one bounded candidate window.
      expect(userProbeLoops).toBeLessThanOrEqual(200);
      expect(userTupleVisits).toBeLessThanOrEqual(200);

      // The lateral lookup must be parameterized by user_id. Counting loops
      // and filtered tuples closes the EXPLAIN loophole where a global/tier
      // scan emits few rows per loop only after inspecting the full table.
      expect(membershipAccessNodes.length).toBeGreaterThan(0);
      expect(membershipUserIndexNodes.length).toBeGreaterThan(0);
      expect(membershipAccessNodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(false);
      const membershipProbeLoops = membershipAccessNodes.reduce(
        (total, node) => total + Number(node["Actual Loops"] ?? 0),
        0,
      );
      expect(membershipProbeLoops).toBe(200);
      const membershipTupleVisits = membershipAccessNodes.reduce(
        (total, node) => total + actualTupleVisitsAcrossLoops(node),
        0,
      );
      expect(membershipTupleVisits).toBeGreaterThan(0);
      expect(membershipTupleVisits).toBeLessThanOrEqual(200 * membershipsPerUser);
      expect(membershipTupleVisits).toBeLessThan(population.length * membershipsPerUser);
    });
  });

  it("serves admin pages from the created_id index without a global sort", async () => {
    const tier = await seedTier(10, "Admin Plan Tier");
    const now = Date.now();
    const population = await db
      .insert(users)
      .values(
        Array.from({ length: 300 }, (_, index) => ({
          email: `admin-plan-${index}-${randomUUID()}@example.test`,
          displayName: `Admin Plan Fan ${index.toString().padStart(3, "0")}`,
        })),
      )
      .returning({ id: users.id });
    await db.insert(memberships).values(
      population.slice(0, 50).map((user, index) => ({
        userId: user.id,
        tierId: tier.id,
        source: "manual" as const,
        startsAt: new Date(now - 60_000),
        endsAt: new Date(now + 24 * 60 * 60 * 1000 + index),
        status: "active" as const,
      })),
    );
    await db.insert(supporterWallEntries).values(
      population.map((user, index) => ({
        userId: user.id,
        dedication: null,
        status: (["pending", "approved", "hidden"] as const)[index % 3]!,
        createdAt: new Date(now - index * 1_000),
        updatedAt: new Date(now - index * 1_000),
      })),
    );

    await db.execute(sql`analyze users`);
    await db.execute(sql`analyze memberships`);
    await db.execute(sql`analyze supporter_wall_entries`);

    const page = await listSupporterWallEntriesPage({ limit: 20 });
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    const cursor = {
      timestamp: page.items.at(-1)!.createdAt.toISOString(),
      id: page.items.at(-1)!.id,
    };

    for (const pageCursor of [null, cursor]) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const rows = await tx.execute<ExplainRow>(
          sql`explain (analyze, format json, costs off, timing off, summary off) ${buildAdminSupporterWallPageQuery({ cursor: pageCursor, limit: 20 })}`,
        );
        const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
        const pathToIndexScan = findPlanPath(
          plan,
          (node) => node["Index Name"] === "supporter_wall_entries_created_id_idx",
        );

        // The keyset page must come straight off the (created_at, id) index:
        // a Limit above the scan and no Sort in between means PostgreSQL
        // never materializes or orders the global entry set for a page.
        expect(pathToIndexScan).not.toBeNull();
        const limitIndex = pathToIndexScan!.findLastIndex((node) => node["Node Type"] === "Limit");
        expect(limitIndex).toBeGreaterThanOrEqual(0);
        for (const node of pathToIndexScan!.slice(limitIndex + 1)) {
          expect(node["Node Type"]).not.toBe("Sort");
        }
        // The active-tier lateral is per returned row, so each membership
        // probe touches one user's memberships, not the global set.
        const membershipNodes = walkPlan(plan).filter(
          (node) => node["Relation Name"] === "memberships",
        );
        expect(membershipNodes.length).toBeGreaterThan(0);
        expect(
          Math.max(...membershipNodes.map((node) => Number(node["Actual Rows"] ?? 0))),
        ).toBeLessThanOrEqual(1);
      });
    }
  });

  it("moves an approved entry back to pending on fan re-edit and hides all dedication text", async () => {
    await enableWall();
    const { approved, user } = await createApprovedSupporter({
      displayName: "Editing Fan",
      dedication: "old dedication",
      level: 10,
    });
    await expect(getSupporterWallViewModel()).resolves.toMatchObject({
      supporters: [expect.objectContaining({ dedication: "old dedication" })],
    });

    const edited = await upsertOptIn({ userId: user.id, dedication: "new dedication" });
    const viewModel = await getSupporterWallViewModel();

    expect(edited).toMatchObject({ id: approved.id, status: "pending", version: 2 });
    await expect(
      db
        .select({
          action: auditEvents.action,
          beforeJson: auditEvents.beforeJson,
          afterJson: auditEvents.afterJson,
          actorType: auditEvents.actorType,
          actorId: auditEvents.actorId,
        })
        .from(auditEvents)
        .where(
          and(eq(auditEvents.entityId, approved.id), eq(auditEvents.action, "fan_edit_reset")),
        ),
    ).resolves.toEqual([
      {
        action: "fan_edit_reset",
        beforeJson: { status: "approved", version: 1 },
        afterJson: { status: "pending", version: 2 },
        actorType: "user",
        actorId: user.id,
      },
    ]);
    expect(JSON.stringify(viewModel)).not.toContain("old dedication");
    expect(JSON.stringify(viewModel)).not.toContain("new dedication");
  });

  it("keeps approved entries approved on a same-dedication resubmit", async () => {
    await enableWall();
    const { approved, user } = await createApprovedSupporter({
      displayName: "Idempotent Fan",
      dedication: "same text",
      level: 10,
    });

    const resubmitted = await upsertOptIn({ userId: user.id, dedication: "same text" });

    expect(resubmitted).toMatchObject({ id: approved.id, status: "approved", version: 1 });
    await expect(getSupporterWallViewModel()).resolves.toMatchObject({
      supporters: [expect.objectContaining({ dedication: "same text" })],
    });
    await expect(
      db.select().from(auditEvents).where(eq(auditEvents.action, "fan_edit_reset")),
    ).resolves.toHaveLength(0);
  });

  it("keeps approved entries approved when the display name is saved unchanged", async () => {
    await enableWall();
    const { approved, user } = await createApprovedSupporter({
      displayName: "Stable Name",
      dedication: "stable dedication",
      level: 10,
    });

    await updateUserDisplayNameWithWallReset({ userId: user.id, displayName: "Stable Name" });

    await expect(
      db
        .select({ status: supporterWallEntries.status, version: supporterWallEntries.version })
        .from(supporterWallEntries)
        .where(eq(supporterWallEntries.id, approved.id)),
    ).resolves.toEqual([{ status: "approved", version: 1 }]);
    await expect(
      db.select().from(auditEvents).where(eq(auditEvents.action, "display_name_reset")),
    ).resolves.toHaveLength(0);
  });

  it("does not audit first-time opt-in or pending fan re-edit", async () => {
    const user = await seedUser("Pending Edit Fan");

    const first = await upsertOptIn({ userId: user.id, dedication: "first" });
    const second = await upsertOptIn({ userId: user.id, dedication: "second" });

    expect(first).toMatchObject({ status: "pending", version: 0 });
    expect(second).toMatchObject({ id: first.id, status: "pending", version: 1 });
    await expect(
      db.select().from(auditEvents).where(eq(auditEvents.entityId, first.id)),
    ).resolves.toHaveLength(0);
  });

  it("audits hidden entry reset on fan re-edit", async () => {
    const admin = await seedAdmin();
    const user = await seedUser("Hidden Edit Fan");
    const entry = await upsertOptIn({ userId: user.id, dedication: "hide me" });
    const approved = await approveSupporterWallEntry({
      id: entry.id,
      expectedVersion: entry.version,
      actor: { type: "admin", id: admin.id },
    });
    const hidden = await hideSupporterWallEntry({
      id: approved.id,
      expectedVersion: approved.version,
      actor: { type: "admin", id: admin.id },
    });

    const edited = await upsertOptIn({ userId: user.id, dedication: "new hidden text" });

    expect(edited).toMatchObject({ id: entry.id, status: "pending", version: 3 });
    await expect(
      db
        .select({
          action: auditEvents.action,
          beforeJson: auditEvents.beforeJson,
          afterJson: auditEvents.afterJson,
        })
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, hidden.id), eq(auditEvents.action, "fan_edit_reset"))),
    ).resolves.toEqual([
      {
        action: "fan_edit_reset",
        beforeJson: { status: "hidden", version: 2 },
        afterJson: { status: "pending", version: 3 },
      },
    ]);
  });

  // ADR 0002: an audit insert failure must roll back the business mutation.
  // The trigger forces the audit insert for one action to fail, then each
  // test asserts the corresponding state change did not survive.
  async function withFailingAudit(action: string, run: () => Promise<void>) {
    await db.execute(
      sql.raw(`
      create function fail_wall_audit() returns trigger as $$
      begin
        if new.action = '${action}' then
          raise exception 'forced audit failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger fail_wall_audit_trigger
      before insert on audit_events
      for each row execute function fail_wall_audit();
    `),
    );
    try {
      await run();
    } finally {
      await db.execute(
        sql.raw(`
        drop trigger if exists fail_wall_audit_trigger on audit_events;
        drop function if exists fail_wall_audit();
      `),
      );
    }
  }

  it("rolls back a settings update when audit insertion fails", async () => {
    const admin = await seedAdmin();

    await withFailingAudit("settings_update", async () => {
      const error = await applySupporterWallSettingsUpdate({
        enabled: true,
        minLevel: 5,
        actor: { type: "admin", id: admin.id },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(flattenErrorChain(error)).toMatch(/forced audit failure/);
    });

    await expect(getSupporterWallSettings()).resolves.toEqual({ enabled: false, minLevel: null });
    await expect(
      db.select().from(auditEvents).where(eq(auditEvents.action, "settings_update")),
    ).resolves.toHaveLength(0);
  });

  it("rolls back a display-name change when the wall reset audit fails", async () => {
    const { approved, user } = await createApprovedSupporter({
      displayName: "Original Name",
      dedication: "keep me",
      level: 10,
    });

    await withFailingAudit("display_name_reset", async () => {
      const error = await updateUserDisplayNameWithWallReset({
        userId: user.id,
        displayName: "New Name",
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(flattenErrorChain(error)).toMatch(/forced audit failure/);
    });

    await expect(
      db.select({ displayName: users.displayName }).from(users).where(eq(users.id, user.id)),
    ).resolves.toEqual([{ displayName: "Original Name" }]);
    await expect(
      db
        .select({ status: supporterWallEntries.status, version: supporterWallEntries.version })
        .from(supporterWallEntries)
        .where(eq(supporterWallEntries.id, approved.id)),
    ).resolves.toEqual([{ status: "approved", version: 1 }]);
  });

  it("rolls back a fan edit when the reset audit fails", async () => {
    const { approved, user } = await createApprovedSupporter({
      displayName: "Audit Edit Fan",
      dedication: "approved text",
      level: 10,
    });

    await withFailingAudit("fan_edit_reset", async () => {
      const error = await upsertOptIn({ userId: user.id, dedication: "replacement" }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(flattenErrorChain(error)).toMatch(/forced audit failure/);
    });

    await expect(
      db
        .select({
          status: supporterWallEntries.status,
          version: supporterWallEntries.version,
          dedication: supporterWallEntries.dedication,
        })
        .from(supporterWallEntries)
        .where(eq(supporterWallEntries.id, approved.id)),
    ).resolves.toEqual([{ status: "approved", version: 1, dedication: "approved text" }]);
  });

  it("rolls back a fan opt-out when audit insertion fails", async () => {
    const { approved, user } = await createApprovedSupporter({
      displayName: "Audit OptOut Fan",
      dedication: "still here",
      level: 10,
    });

    await withFailingAudit("opt_out", async () => {
      const error = await optOut({ userId: user.id }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(flattenErrorChain(error)).toMatch(/forced audit failure/);
    });

    await expect(
      db
        .select({ id: supporterWallEntries.id, status: supporterWallEntries.status })
        .from(supporterWallEntries)
        .where(eq(supporterWallEntries.userId, user.id)),
    ).resolves.toEqual([{ id: approved.id, status: "approved" }]);
  });

  it("rolls back moderation when audit insertion fails", async () => {
    const admin = await seedAdmin();
    const user = await seedUser("Audit Moderation Fan");
    const entry = await upsertOptIn({ userId: user.id, dedication: "moderate me" });

    await withFailingAudit("approve", async () => {
      const error = await approveSupporterWallEntry({
        id: entry.id,
        expectedVersion: 0,
        actor: { type: "admin", id: admin.id },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(flattenErrorChain(error)).toMatch(/forced audit failure/);
    });

    await expect(
      db
        .select({ status: supporterWallEntries.status, version: supporterWallEntries.version })
        .from(supporterWallEntries)
        .where(eq(supporterWallEntries.id, entry.id)),
    ).resolves.toEqual([{ status: "pending", version: 0 }]);
    await expect(
      db.select().from(auditEvents).where(eq(auditEvents.entityId, entry.id)),
    ).resolves.toHaveLength(0);
  });

  it("keeps email out of supporter wall fan, public, admin, and audit payloads", async () => {
    await enableWall();
    const { approved, user } = await createApprovedSupporter({
      displayName: "No Email Fan",
      dedication: "thank you",
      level: 10,
    });

    const fanPayload = await getMyWallEntry(user.id);
    const publicPayload = await getSupporterWallViewModel();
    const adminPayload = await listSupporterWallEntriesPage({ limit: 10 });
    await optOut({ userId: user.id });
    const auditPayload = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, approved.id));

    const combined = JSON.stringify({ fanPayload, publicPayload, adminPayload, auditPayload });
    expect(combined).not.toContain(user.email);
    expect(publicPayload).toMatchObject({
      supporters: [{ displayName: "No Email Fan", tierName: "Tier 10", dedication: "thank you" }],
    });
    expect(adminPayload.items[0]).toMatchObject({
      displayName: "No Email Fan",
      activeTierName: "Tier 10",
    });
  });

  it("requires displayName before fan opt-in", async () => {
    const user = await seedUser(null);

    await expect(upsertOptIn({ userId: user.id, dedication: "hello" })).rejects.toMatchObject({
      status: 400,
      code: "displayNameRequired",
    });
    await expect(db.select().from(supporterWallEntries)).resolves.toHaveLength(0);
  });
});
