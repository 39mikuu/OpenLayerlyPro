import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { files, memberships, membershipTiers, paymentRequests, users } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { listFilesPage, listQuarantinedFilesPage } from "@/modules/file";
import { listMembershipsPage } from "@/modules/membership";
import { listPaymentRequestsPage } from "@/modules/payment";
import { listUsersPage } from "@/modules/user";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("admin keyset pagination integration", () => {
  const db = getDb();
  const countedRaw = postgres(getEnv().DATABASE_URL, { max: 1, onnotice: () => {} });
  const queryCounter = {
    count: 0,
    logQuery: () => {
      queryCounter.count += 1;
    },
  };
  const countedDb = drizzle(countedRaw, { schema, logger: queryCounter });
  let userId: string;
  let tierId: string;

  afterAll(async () => {
    await countedRaw.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await db.delete(paymentRequests);
    await db.delete(memberships);
    await db.delete(files);
    await db.delete(membershipTiers);
    await db.delete(users);
    const [user] = await db
      .insert(users)
      .values({ email: `pagination-${randomUUID()}@example.com` })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Pagination",
        slug: `pagination-${randomUUID()}`,
        priceLabel: "100",
        level: 1,
      })
      .returning();
    userId = user!.id;
    tierId = tier!.id;
  });

  async function insertMembership(id: string, createdAt: string) {
    await db.execute(sql`
      insert into memberships (
        id, user_id, tier_id, source, starts_at, ends_at, created_at
      ) values (
        ${id}::uuid, ${userId}::uuid, ${tierId}::uuid, 'manual',
        now(), now() + interval '1 day', ${createdAt}::timestamptz
      )
    `);
  }

  it("paginates users at microsecond boundaries and resolves membership in one query", async () => {
    await db.delete(memberships);
    await db.delete(users);
    const high = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const low = "00000000-0000-4000-8000-000000000001";
    const oldest = randomUUID();
    await db.execute(sql`
      insert into users (id, email, password_hash, created_at) values
        (${high}::uuid, ${`high-${randomUUID()}@example.com`}, 'secret-hash',
         '2026-07-02T00:00:00.000500Z'::timestamptz),
        (${low}::uuid, ${`low-${randomUUID()}@example.com`}, 'secret-hash',
         '2026-07-02T00:00:00.000500Z'::timestamptz),
        (${oldest}::uuid, ${`oldest-${randomUUID()}@example.com`}, 'secret-hash',
         '2026-07-02T00:00:00.000100Z'::timestamptz)
    `);
    const [higherTier] = await db
      .insert(membershipTiers)
      .values({
        name: "Higher pagination tier",
        slug: `higher-pagination-${randomUUID()}`,
        priceLabel: "200",
        level: 10,
      })
      .returning();
    await db.insert(memberships).values([
      {
        userId: high,
        tierId,
        source: "manual",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
      },
      {
        userId: high,
        tierId: higherTier!.id,
        source: "manual",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 120_000),
      },
    ]);

    queryCounter.count = 0;
    const first = await listUsersPage({ limit: 2 }, countedDb);
    expect(queryCounter.count).toBe(1);
    expect(first.items.map((item) => item.user.id)).toEqual([high, low]);
    expect(first.items[0]?.activeMembership).toMatchObject({
      tierName: "Higher pagination tier",
    });
    expect(first.items[1]?.activeMembership).toBeNull();
    expect(first.items[0]?.user).not.toHaveProperty("passwordHash");

    await db.execute(sql`
      insert into users (email, created_at)
      values (${`new-${randomUUID()}@example.com`}, '2026-07-02T00:00:01.000000Z'::timestamptz)
    `);
    queryCounter.count = 0;
    const second = await listUsersPage({ limit: 2, cursor: first.nextCursor }, countedDb);
    expect(queryCounter.count).toBe(1);
    expect(second.items.map((item) => item.user.id)).toEqual([oldest]);
    expect(second.nextCursor).toBeNull();
  });

  it("uses microseconds and UUID as membership boundaries without repeats", async () => {
    const high = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const low = "00000000-0000-4000-8000-000000000001";
    const oldest = randomUUID();
    await insertMembership(high, "2026-07-02T00:00:00.000500Z");
    await insertMembership(low, "2026-07-02T00:00:00.000500Z");
    await insertMembership(oldest, "2026-07-02T00:00:00.000100Z");

    const first = await listMembershipsPage({ limit: 2 });
    await insertMembership(randomUUID(), "2026-07-02T00:00:01.000000Z");
    const second = await listMembershipsPage({ limit: 2, cursor: first.nextCursor });

    expect(first.items.map((item) => item.membership.id)).toEqual([high, low]);
    expect(second.items.map((item) => item.membership.id)).toEqual([oldest]);
    expect(second.nextCursor).toBeNull();
  });

  it("keeps pending and history payment streams independent", async () => {
    const [secondUser, thirdUser] = await db
      .insert(users)
      .values([
        { email: `pagination-${randomUUID()}@example.com` },
        { email: `pagination-${randomUUID()}@example.com` },
      ])
      .returning();
    const pendingHigh = "dddddddd-dddd-4ddd-bddd-dddddddddddd";
    const pendingLow = "cccccccc-cccc-4ccc-bccc-cccccccccccc";
    const pendingOldest = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const historyHigh = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const historyLow = "00000000-0000-4000-8000-000000000001";
    const historyOldest = randomUUID();
    await db.execute(sql`
      insert into payment_requests (
        id, user_id, tier_id, status, amount_label, duration_days, created_at
      ) values
        (${pendingHigh}::uuid, ${userId}::uuid, ${tierId}::uuid, 'pending_review', '100', 31,
         '2026-07-02T00:00:03.000003Z'::timestamptz),
        (${pendingLow}::uuid, ${secondUser!.id}::uuid, ${tierId}::uuid, 'pending_review', '100', 31,
         '2026-07-02T00:00:03.000003Z'::timestamptz),
        (${pendingOldest}::uuid, ${thirdUser!.id}::uuid, ${tierId}::uuid, 'pending_review', '100', 31,
         '2026-07-02T00:00:01.000001Z'::timestamptz),
        (${historyHigh}::uuid, ${userId}::uuid, ${tierId}::uuid, 'approved', '100', 31,
         '2026-07-02T00:00:02.000002Z'::timestamptz),
        (${historyLow}::uuid, ${userId}::uuid, ${tierId}::uuid, 'approved', '100', 31,
         '2026-07-02T00:00:02.000002Z'::timestamptz),
        (${historyOldest}::uuid, ${userId}::uuid, ${tierId}::uuid, 'rejected', '100', 31,
         '2026-07-02T00:00:01.000001Z'::timestamptz)
    `);

    const pendingFirst = await listPaymentRequestsPage({ status: "pending_review", limit: 2 });
    const pendingSecond = await listPaymentRequestsPage({
      status: "pending_review",
      cursor: pendingFirst.nextCursor,
      limit: 2,
    });
    await expect(
      listPaymentRequestsPage({
        excludeStatus: "pending_review",
        cursor: pendingFirst.nextCursor,
        limit: 2,
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalidCursor" });
    const historyFirst = await listPaymentRequestsPage({
      excludeStatus: "pending_review",
      limit: 2,
    });
    const historySecond = await listPaymentRequestsPage({
      excludeStatus: "pending_review",
      cursor: historyFirst.nextCursor,
      limit: 2,
    });

    expect(pendingFirst.items.map((item) => item.request.id)).toEqual([pendingHigh, pendingLow]);
    expect(pendingSecond.items.map((item) => item.request.id)).toEqual([pendingOldest]);
    expect(historyFirst.items.map((item) => item.request.id)).toEqual([historyHigh, historyLow]);
    expect(historySecond.items.map((item) => item.request.id)).toEqual([historyOldest]);
    expect(pendingSecond.nextCursor).toBeNull();
    expect(historySecond.nextCursor).toBeNull();
  });

  it("paginates active and quarantined files on their respective sort timestamps", async () => {
    const activeHigh = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const activeLow = "00000000-0000-4000-8000-000000000001";
    const activeOldest = randomUUID();
    const quarantineNew = randomUUID();
    const quarantineHigh = "eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee";
    const quarantineLow = "11111111-1111-4111-8111-111111111111";
    await db.execute(sql`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose,
        created_at, quarantined_at
      ) values
        (${activeHigh}::uuid, 'local', ${activeHigh}, 'active-high', 'text/plain', 1,
         'content_attachment', '2026-07-02T00:00:03.000003Z'::timestamptz, null),
        (${activeLow}::uuid, 'local', ${activeLow}, 'active-low', 'text/plain', 1,
         'content_attachment', '2026-07-02T00:00:03.000003Z'::timestamptz, null),
        (${activeOldest}::uuid, 'local', ${activeOldest}, 'active-oldest', 'text/plain', 1,
         'content_attachment', '2026-07-02T00:00:01.000001Z'::timestamptz, null),
        (${quarantineHigh}::uuid, 'local', ${quarantineHigh}, 'high', 'text/plain', 1,
         'content_attachment', '2026-07-02T00:00:02Z'::timestamptz,
         '2026-07-02T00:00:01.000001Z'::timestamptz),
        (${quarantineLow}::uuid, 'local', ${quarantineLow}, 'low', 'text/plain', 1,
         'content_attachment', '2026-07-02T00:00:02Z'::timestamptz,
         '2026-07-02T00:00:01.000001Z'::timestamptz),
        (${quarantineNew}::uuid, 'local', ${quarantineNew}, 'new', 'text/plain', 1,
         'content_attachment', '2026-07-02T00:00:01Z'::timestamptz,
         '2026-07-02T00:00:02.000002Z'::timestamptz)
    `);

    const activeFirst = await listFilesPage({ limit: 2 });
    const activeSecond = await listFilesPage({ limit: 2, cursor: activeFirst.nextCursor });
    const quarantineFirst = await listQuarantinedFilesPage({ limit: 2 });
    const quarantineSecond = await listQuarantinedFilesPage({
      limit: 2,
      cursor: quarantineFirst.nextCursor,
    });
    await expect(
      listQuarantinedFilesPage({ limit: 2, cursor: activeFirst.nextCursor }),
    ).rejects.toMatchObject({ status: 400, code: "invalidCursor" });

    expect(activeFirst.items.map((item) => item.id)).toEqual([activeHigh, activeLow]);
    expect(activeSecond.items.map((item) => item.id)).toEqual([activeOldest]);
    expect(quarantineFirst.items.map((item) => item.id)).toEqual([quarantineNew, quarantineHigh]);
    expect(quarantineSecond.items.map((item) => item.id)).toEqual([quarantineLow]);
    expect(activeSecond.nextCursor).toBeNull();
    expect(quarantineSecond.nextCursor).toBeNull();
  });
});
