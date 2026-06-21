import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { auditEvents, memberships, membershipTiers, paymentRequests, users } from "@/db/schema";

import {
  acquireUserGrantLock,
  extendMembership,
  getActiveMembership,
  getMembershipDetail,
  grantMembership,
  listMembershipHistory,
  resumeMembership,
  revokeMembership,
  suspendMembership,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("membership lifecycle integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(auditEvents);
    await db.delete(paymentRequests);
    await db.delete(memberships);
    await db.delete(membershipTiers);
    await db.delete(users);
  });

  async function seed(options: { tierActive?: boolean } = {}) {
    const [user] = await db
      .insert(users)
      .values({ email: `member-${randomUUID()}@example.com` })
      .returning();
    const [admin] = await db
      .insert(users)
      .values({ email: `admin-${randomUUID()}@example.com`, role: "admin" })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Supporter",
        slug: `supporter-${randomUUID()}`,
        priceLabel: "500",
        level: 10,
        durationDays: 31,
        isActive: options.tierActive ?? true,
      })
      .returning();
    return { admin, user, tier };
  }

  it("grants and audits a membership while an inactive tier remains valid for access", async () => {
    const { user, tier } = await seed({ tierActive: false });
    const correlationId = randomUUID();
    const result = await grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "manual",
      note: "private note",
      actor: { type: "system", id: null },
      correlationId,
    });

    const active = await getActiveMembership(user.id);
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, result.membership.id));

    expect(active?.membership.id).toBe(result.membership.id);
    expect(result.membership.status).toBe("active");
    expect(result.membership.version).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "grant",
      actorType: "system",
      correlationId,
      beforeJson: null,
    });
    expect(events[0]?.afterJson).not.toHaveProperty("note");
    expect(events[0]?.afterJson).not.toHaveProperty("userId");
  });

  it("suspends, resumes, and revokes with versioned audit history", async () => {
    const { admin, user, tier } = await seed();
    const correlationId = randomUUID();
    const { membership } = await grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "manual",
      actor: { type: "system", id: null },
      correlationId,
    });
    const [grantEvent] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, membership.id));
    if (!grantEvent) throw new Error("grant audit event missing");

    const suspended = await suspendMembership(membership.id, {
      reason: "support request",
      actor: { type: "admin", id: admin.id },
      expectedVersion: 0,
      correlationId,
      causationId: grantEvent.id,
    });
    expect(suspended).toMatchObject({ status: "suspended", version: 1 });
    const [suspendEvent] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "suspend"));
    expect(suspendEvent).toMatchObject({
      correlationId,
      causationId: grantEvent.id,
    });
    await expect(getActiveMembership(user.id)).resolves.toBeNull();

    const extended = await extendMembership(membership.id, {
      days: 7,
      actor: { type: "admin", id: admin.id },
      expectedVersion: 1,
    });
    expect(extended).toMatchObject({ status: "suspended", version: 2 });
    await expect(getActiveMembership(user.id)).resolves.toBeNull();

    const resumed = await resumeMembership(membership.id, {
      reason: "support completed",
      actor: { type: "admin", id: admin.id },
      expectedVersion: 2,
    });
    expect(resumed).toMatchObject({ status: "active", version: 3 });
    expect((await getActiveMembership(user.id))?.membership.id).toBe(membership.id);

    const revoked = await revokeMembership(membership.id, {
      reason: "manual revoke",
      actor: { type: "admin", id: admin.id },
      expectedVersion: 3,
    });
    expect(revoked).toMatchObject({ status: "revoked", version: 4 });
    await expect(getActiveMembership(user.id)).resolves.toBeNull();

    const events = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, membership.id));
    expect(events.map((event) => event.action).sort()).toEqual([
      "extend",
      "grant",
      "resume",
      "revoke",
      "suspend",
    ]);

    const detail = await getMembershipDetail(membership.id);
    const history = await listMembershipHistory(membership.id);
    expect(detail).toMatchObject({
      membership: { id: membership.id, status: "revoked", version: 4 },
      tier: { id: tier.id, name: "Supporter" },
      userEmail: user.email,
    });
    expect(history.map((event) => event.action)).toEqual([
      "revoke",
      "resume",
      "extend",
      "suspend",
      "grant",
    ]);
  });

  it("rejects duplicate state commands and stale extension retries", async () => {
    const { admin, user, tier } = await seed();
    const { membership } = await grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "manual",
      actor: { type: "system", id: null },
    });
    const extensions = await Promise.allSettled([
      extendMembership(membership.id, {
        days: 7,
        actor: { type: "admin", id: admin.id },
        expectedVersion: 0,
      }),
      extendMembership(membership.id, {
        days: 7,
        actor: { type: "admin", id: admin.id },
        expectedVersion: 0,
      }),
    ]);
    const fulfilled = extensions.filter(
      (result): result is PromiseFulfilledResult<typeof membership> =>
        result.status === "fulfilled",
    );
    const rejected = extensions.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      status: 409,
      code: "membershipStale",
    });
    const extended = fulfilled[0]!.value;

    const suspended = await suspendMembership(membership.id, {
      reason: "pause",
      actor: { type: "admin", id: admin.id },
      expectedVersion: 1,
    });
    await expect(
      suspendMembership(membership.id, {
        reason: "pause again",
        actor: { type: "admin", id: admin.id },
        expectedVersion: suspended.version,
      }),
    ).rejects.toMatchObject({ status: 409, code: "alreadyInState" });

    const [stored] = await db.select().from(memberships).where(eq(memberships.id, membership.id));
    expect(stored?.endsAt.toISOString()).toBe(extended.endsAt.toISOString());
  });

  it("rolls back the state update when audit insertion fails", async () => {
    const { admin, user, tier } = await seed();
    const { membership } = await grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "manual",
      actor: { type: "system", id: null },
    });

    await db.execute(
      sql.raw(`
      create function fail_membership_audit() returns trigger as $$
      begin
        if new.action = 'suspend' then
          raise exception 'forced audit failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger fail_membership_audit_trigger
      before insert on audit_events
      for each row execute function fail_membership_audit();
    `),
    );

    try {
      await expect(
        suspendMembership(membership.id, {
          reason: "must roll back",
          actor: { type: "admin", id: admin.id },
          expectedVersion: 0,
        }),
      ).rejects.toThrow();
    } finally {
      await db.execute(
        sql.raw(`
        drop trigger if exists fail_membership_audit_trigger on audit_events;
        drop function if exists fail_membership_audit();
      `),
      );
    }

    const [stored] = await db.select().from(memberships).where(eq(memberships.id, membership.id));
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, membership.id));
    expect(stored).toMatchObject({ status: "active", version: 0 });
    expect(events.map((event) => event.action)).toEqual(["grant"]);
  });

  it("creates three back-to-back grants without overlap or lost duration", async () => {
    const { user, tier } = await seed();
    const grants = [];
    for (let index = 0; index < 3; index += 1) {
      grants.push(
        await grantMembership({
          userId: user.id,
          tierId: tier.id,
          source: "manual",
          actor: { type: "system", id: null },
        }),
      );
    }

    expect(grants[1]!.membership.startsAt.toISOString()).toBe(
      grants[0]!.membership.endsAt.toISOString(),
    );
    expect(grants[2]!.membership.startsAt.toISOString()).toBe(
      grants[1]!.membership.endsAt.toISOString(),
    );
    expect(grants[2]!.membership.endsAt.getTime() - grants[0]!.membership.startsAt.getTime()).toBe(
      93 * 24 * 60 * 60 * 1000,
    );
  });

  it("serializes concurrent grants and makes the second observe the first scheduled period", async () => {
    const { user, tier } = await seed();
    const results = await Promise.all([
      grantMembership({
        userId: user.id,
        tierId: tier.id,
        source: "manual",
        actor: { type: "system", id: null },
      }),
      grantMembership({
        userId: user.id,
        tierId: tier.id,
        source: "gift",
        actor: { type: "system", id: null },
      }),
    ]);
    const ordered = results
      .map((result) => result.membership)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

    expect(ordered).toHaveLength(2);
    expect(ordered[1]!.startsAt.toISOString()).toBe(ordered[0]!.endsAt.toISOString());
    expect(ordered[1]!.endsAt.getTime() - ordered[0]!.startsAt.getTime()).toBe(
      62 * 24 * 60 * 60 * 1000,
    );
  });

  it("holds the user grant lock until transaction commit", async () => {
    const { user, tier } = await seed();
    const firstStartsAt = new Date(Date.now() - 60_000);
    const firstEndsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    let releaseFirst!: () => void;
    let markLocked!: () => void;
    const release = new Promise<void>((resolve) => (releaseFirst = resolve));
    const locked = new Promise<void>((resolve) => (markLocked = resolve));

    const first = db.transaction(async (tx) => {
      await acquireUserGrantLock(tx, user.id);
      markLocked();
      await release;
      await tx.insert(memberships).values({
        userId: user.id,
        tierId: tier.id,
        source: "external",
        startsAt: firstStartsAt,
        endsAt: firstEndsAt,
        status: "active",
      });
    });
    await locked;

    let secondFinished = false;
    const second = grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "manual",
      actor: { type: "system", id: null },
    }).then((result) => {
      secondFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondFinished).toBe(false);

    releaseFirst();
    await first;
    const result = await second;
    expect(result.membership.startsAt.toISOString()).toBe(firstEndsAt.toISOString());
  });

  it("uses scheduled and suspended same-or-higher tiers as anchors", async () => {
    const { user, tier } = await seed();
    const scheduledEnd = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const suspendedEnd = new Date(Date.now() + 70 * 24 * 60 * 60 * 1000);
    await db.insert(memberships).values([
      {
        userId: user.id,
        tierId: tier.id,
        source: "external",
        startsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        endsAt: scheduledEnd,
        status: "active",
      },
      {
        userId: user.id,
        tierId: tier.id,
        source: "external",
        startsAt: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
        endsAt: suspendedEnd,
        status: "suspended",
      },
    ]);

    const granted = await grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "manual",
      actor: { type: "system", id: null },
    });
    expect(granted.membership.startsAt.toISOString()).toBe(suspendedEnd.toISOString());
  });

  it("ignores revoked and expired rows when choosing a grant anchor", async () => {
    const { user, tier } = await seed();
    await db.insert(memberships).values([
      {
        userId: user.id,
        tierId: tier.id,
        source: "external",
        startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: "revoked",
      },
      {
        userId: user.id,
        tierId: tier.id,
        source: "external",
        startsAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        status: "active",
      },
    ]);
    const before = Date.now();
    const granted = await grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "manual",
      actor: { type: "system", id: null },
    });
    expect(granted.membership.startsAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(granted.membership.startsAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("defers a lower-tier grant behind higher-tier rights but starts an upgrade immediately", async () => {
    const { user, tier: lowTier } = await seed();
    const [highTier] = await db
      .insert(membershipTiers)
      .values({
        name: "Premium",
        slug: `premium-${randomUUID()}`,
        priceLabel: "1000",
        level: 20,
        durationDays: 31,
      })
      .returning();
    const highGrant = await grantMembership({
      userId: user.id,
      tierId: highTier.id,
      source: "manual",
      actor: { type: "system", id: null },
    });
    const lowGrant = await grantMembership({
      userId: user.id,
      tierId: lowTier.id,
      source: "manual",
      actor: { type: "system", id: null },
    });
    expect(lowGrant.membership.startsAt.toISOString()).toBe(
      highGrant.membership.endsAt.toISOString(),
    );

    const [secondUser] = await db
      .insert(users)
      .values({ email: `upgrade-${randomUUID()}@example.com` })
      .returning();
    const lowActive = await grantMembership({
      userId: secondUser.id,
      tierId: lowTier.id,
      source: "manual",
      actor: { type: "system", id: null },
    });
    const beforeUpgrade = Date.now();
    const upgrade = await grantMembership({
      userId: secondUser.id,
      tierId: highTier.id,
      source: "manual",
      actor: { type: "system", id: null },
    });
    expect(upgrade.membership.startsAt.getTime()).toBeGreaterThanOrEqual(beforeUpgrade);
    expect(upgrade.membership.startsAt.getTime()).toBeLessThan(
      lowActive.membership.endsAt.getTime(),
    );
  });
});
