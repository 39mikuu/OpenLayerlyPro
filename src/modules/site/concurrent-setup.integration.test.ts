import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Issue #103 — deterministic reproduction of concurrent first-time initialization.
 *
 * `setupSite()` checks `isInitialized()` before opening its transaction and never
 * rechecks inside it, so two concurrent callers can both pass the precheck. This
 * file establishes what actually happens when they race, using:
 *   1. an end-to-end race of the real `setupSite()` (same and different emails), and
 *   2. a barrier-controlled two-connection reproduction that forces both callers
 *      through the precheck window before either commits.
 *
 * No production code is changed. The tests assert the observed, constraint-enforced
 * outcome so the file is a living record of the race resolution.
 */
import { getDb } from "@/db";
import { membershipTiers, siteSettings, users } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { isInitialized, setupSite } from "@/modules/site";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

function baseInput(email: string) {
  return {
    siteName: "Site",
    artistName: "Artist",
    artistBio: "Bio",
    adminEmail: email,
    adminPassword: "correct horse battery staple",
  };
}

describeWithDatabase("issue #103 concurrent first-time initialization", () => {
  const db = getDb();
  // Dedicated raw client (>=2 connections) for the barrier reproduction.
  const raw = postgres(getEnv().DATABASE_URL, { max: 4, onnotice: () => {} });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await resetDatabase(db);
    await raw.end({ timeout: 5 });
  });

  async function finalState() {
    const admins = await db.select().from(users).where(eq(users.role, "admin"));
    const tiers = await db.select().from(membershipTiers);
    const initialized = await isInitialized();
    return { admins, tiers, initialized };
  }

  it("resolves a two-caller race with different emails to a single admin", async () => {
    const emailA = `a-${randomUUID()}@example.test`;
    const emailB = `b-${randomUUID()}@example.test`;

    const results = await Promise.allSettled([
      setupSite(baseInput(emailA)),
      setupSite(baseInput(emailB)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // Exactly one caller wins; the other is rejected (either a clean 403
    // siteInitialized if the precheck caught it, or a unique violation on the
    // membership_tiers.slug / users.email constraints if they truly overlapped).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const state = await finalState();
    // No partial initialization: a single admin, exactly one default tier set,
    // and initialized=true.
    expect(state.admins).toHaveLength(1);
    expect(state.tiers).toHaveLength(3);
    expect(state.initialized).toBe(true);
    // The surviving admin is one of the two candidates, never a merged/duplicate.
    expect([emailA, emailB]).toContain(state.admins[0]!.email);
  });

  it("resolves a two-caller race with the same email to a single admin", async () => {
    const email = `dup-${randomUUID()}@example.test`;

    const results = await Promise.allSettled([
      setupSite(baseInput(email)),
      setupSite(baseInput(email)),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const state = await finalState();
    expect(state.admins).toHaveLength(1);
    expect(state.admins[0]!.email).toBe(email);
    expect(state.tiers).toHaveLength(3);
    expect(state.initialized).toBe(true);
  });

  it("barrier: both callers pass the precheck, but the tier slug constraint serializes them", async () => {
    const emailA = `barrier-a-${randomUUID()}@example.test`;
    const emailB = `barrier-b-${randomUUID()}@example.test`;

    const c1 = await raw.reserve();
    const c2 = await raw.reserve();
    try {
      await c1`begin`;
      await c2`begin`;

      // Both callers run the precheck (SELECT initialized) inside the race window
      // before either commits. Both observe "not initialized".
      const pre1 = await c1`select value_json from site_settings where key = 'initialized'`;
      const pre2 = await c2`select value_json from site_settings where key = 'initialized'`;
      expect(pre1).toHaveLength(0);
      expect(pre2).toHaveLength(0);

      // Replicates setupSite's transaction body faithfully.
      const runSetup = (c: postgres.ReservedSql, email: string) => async () => {
        await c`insert into users (email, password_hash, role, display_name)
                values (${email}, 'hash', 'admin', 'Artist')
                on conflict (email) do update set password_hash = 'hash', role = 'admin', updated_at = now()`;
        for (const t of [
          ["Supporter", "supporter", "p1", 10],
          ["HD", "hd-member", "p2", 20],
          ["Pack", "pack-member", "p3", 30],
        ] as const) {
          await c`insert into membership_tiers (name, slug, price_label, level)
                  values (${t[0]}, ${t[1]}, ${t[2]}, ${t[3]})`;
        }
        await c`insert into site_settings (key, value_json)
                values ('initialized', 'true'::jsonb)
                on conflict (key) do update set value_json = 'true'::jsonb, updated_at = now()`;
      };

      // c1 runs its full body first and commits.
      await runSetup(c1, emailA)();
      await c1`commit`;

      // c2 now attempts the same slugs; it must hit the unique constraint and roll back.
      let c2Error: unknown = null;
      try {
        await runSetup(c2, emailB)();
        await c2`commit`;
      } catch (err) {
        c2Error = err;
        await c2`rollback`;
      }

      expect(c2Error).not.toBeNull();
      expect(String((c2Error as { message?: string })?.message)).toMatch(/duplicate key|unique/i);
    } finally {
      await c1.release();
      await c2.release();
    }

    // After the loser rolls back: exactly one admin (the winner), one tier set,
    // initialized=true. The loser's admin (emailB) was never persisted, and there
    // is no partial state.
    const admins = await db.select().from(users).where(eq(users.role, "admin"));
    expect(admins).toHaveLength(1);
    expect(admins[0]!.email).toBe(emailA);
    const loser = await db
      .select()
      .from(users)
      .where(and(eq(users.email, emailB)));
    expect(loser).toHaveLength(0);
    expect(await db.select().from(membershipTiers)).toHaveLength(3);
    expect(
      await db.select().from(siteSettings).where(eq(siteSettings.key, "initialized")),
    ).toHaveLength(1);
    expect(await isInitialized()).toBe(true);
  });
});
