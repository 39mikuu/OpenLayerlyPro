import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { files, memberships, membershipTiers, paymentRequests, users } from "@/db/schema";
import { listFilesPage, listQuarantinedFilesPage } from "@/modules/file";
import { listMembershipsPage } from "@/modules/membership";
import { listPaymentRequestsPage } from "@/modules/payment";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("admin keyset pagination integration", () => {
  const db = getDb();
  let userId: string;
  let tierId: string;

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
    const pending = randomUUID();
    const approved = randomUUID();
    await db.execute(sql`
      insert into payment_requests (
        id, user_id, tier_id, status, amount_label, duration_days, created_at
      ) values
        (${pending}::uuid, ${userId}::uuid, ${tierId}::uuid, 'pending_review', '100', 31,
         '2026-07-02T00:00:02.000002Z'::timestamptz),
        (${approved}::uuid, ${userId}::uuid, ${tierId}::uuid, 'approved', '100', 31,
         '2026-07-02T00:00:01.000001Z'::timestamptz)
    `);

    const pendingPage = await listPaymentRequestsPage({ status: "pending_review", limit: 1 });
    const historyPage = await listPaymentRequestsPage({
      excludeStatus: "pending_review",
      limit: 1,
    });

    expect(pendingPage.items.map((item) => item.request.id)).toEqual([pending]);
    expect(historyPage.items.map((item) => item.request.id)).toEqual([approved]);
  });

  it("paginates active and quarantined files on their respective sort timestamps", async () => {
    const active = randomUUID();
    const quarantineNew = randomUUID();
    const quarantineOld = randomUUID();
    await db.execute(sql`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose,
        created_at, quarantined_at
      ) values
        (${active}::uuid, 'local', ${active}, 'active', 'text/plain', 1, 'content_attachment',
         '2026-07-02T00:00:03.000003Z'::timestamptz, null),
        (${quarantineOld}::uuid, 'local', ${quarantineOld}, 'old', 'text/plain', 1,
         'content_attachment', '2026-07-02T00:00:02Z'::timestamptz,
         '2026-07-02T00:00:01.000001Z'::timestamptz),
        (${quarantineNew}::uuid, 'local', ${quarantineNew}, 'new', 'text/plain', 1,
         'content_attachment', '2026-07-02T00:00:01Z'::timestamptz,
         '2026-07-02T00:00:02.000002Z'::timestamptz)
    `);

    expect((await listFilesPage({ limit: 1 })).items.map((item) => item.id)).toEqual([active]);
    expect((await listQuarantinedFilesPage({ limit: 2 })).items.map((item) => item.id)).toEqual([
      quarantineNew,
      quarantineOld,
    ]);
  });
});
