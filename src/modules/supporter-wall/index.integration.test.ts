import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
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
  getMyWallEntry,
  getSupporterWallViewModel,
  hideSupporterWallEntry,
  listSupporterWallEntriesPage,
  optOut,
  upsertOptIn,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

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

  it("uses the user_id unique constraint for concurrent fan opt-ins", async () => {
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
    expect(viewModel?.supporters.map((supporter) => supporter.displayName)).not.toEqual(
      expect.arrayContaining(["Expired Fan", "Suspended Fan", "Revoked Fan", "Reversed Fan"]),
    );
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
      supporters: [
        expect.objectContaining({ displayName: "High Fan" }),
        expect.objectContaining({ displayName: "Low Fan" }),
      ],
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
    expect(JSON.stringify(viewModel)).not.toContain("old dedication");
    expect(JSON.stringify(viewModel)).not.toContain("new dedication");
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
