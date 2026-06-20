import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  getPaymentProvider: vi.fn(),
  resolveCheckoutByPaymentIntent: vi.fn(),
}));

vi.mock("./providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("./providers")>();
  return {
    ...original,
    getPaymentProvider: providerMocks.getPaymentProvider,
  };
});

import { getDb } from "@/db";
import {
  auditEvents,
  memberships,
  membershipTiers,
  paymentRequests,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import { confirmAutoPayment, reverseAutoPayment, reversePaymentApproval } from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("Stripe refund and dispute reversal integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    vi.clearAllMocks();
    providerMocks.getPaymentProvider.mockResolvedValue({
      id: "stripe",
      resolveCheckoutByPaymentIntent: providerMocks.resolveCheckoutByPaymentIntent,
    });
    providerMocks.resolveCheckoutByPaymentIntent.mockResolvedValue(null);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seedRequest(options?: {
    status?: "pending_payment" | "approved" | "rejected" | "cancelled" | "reversed";
    provider?: string;
    providerRef?: string;
    providerPaymentRef?: string | null;
  }) {
    const [user] = await db
      .insert(users)
      .values({ email: `fan-${randomUUID()}@example.test`, locale: "ja" })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Supporter",
        slug: `supporter-${randomUUID()}`,
        priceLabel: "$5",
        priceAmountMinor: 500,
        currency: "usd",
        level: 10,
        durationDays: 31,
      })
      .returning();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: options?.status ?? "pending_payment",
        provider: options?.provider ?? "stripe",
        providerRef: options?.providerRef ?? "cs_test",
        providerPaymentRef: options?.providerPaymentRef ?? null,
        amountMinor: 500,
        currency: "usd",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();
    return { user: user!, tier: tier!, request: request! };
  }

  function paidEvent(providerRef: string, paymentRef: string, requestId?: string) {
    return {
      type: "paid" as const,
      providerRef,
      paymentRef,
      requestId,
      providerEventId: `evt_paid_${randomUUID()}`,
      amountMinor: 500,
      currency: "usd",
    };
  }

  it("reverses a paid request after a full refund and preserves the audit causation chain", async () => {
    const { request, user } = await seedRequest({ providerRef: "cs_refund" });
    await confirmAutoPayment("stripe", paidEvent("cs_refund", "pi_refund", request.id));

    await reverseAutoPayment("stripe", {
      type: "refunded",
      paymentRef: "pi_refund",
      providerEventId: "evt_refund",
    });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, stored!.grantedMembershipId!));
    const [refundAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityId, request.id), eq(auditEvents.action, "payment_auto_refunded")),
      );
    const [revokeAudit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, membership!.id), eq(auditEvents.action, "revoke")));
    const queued = await db.select().from(tasks).orderBy(tasks.createdAt);

    expect(stored).toMatchObject({
      status: "reversed",
      providerPaymentRef: "pi_refund",
      reversalEventId: "evt_refund",
    });
    expect(membership).toMatchObject({ userId: user.id, status: "revoked", version: 1 });
    expect(refundAudit).toMatchObject({
      actorType: "system",
      beforeJson: { status: "approved" },
      afterJson: expect.objectContaining({
        status: "reversed",
        kind: "refunded",
        provider: "stripe",
      }),
    });
    expect(revokeAudit).toMatchObject({
      correlationId: refundAudit!.correlationId,
      causationId: refundAudit!.id,
    });
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({
      dedupeKey: `email:membership_revoked:${request.id}`,
      payloadJson: {
        template: "membership_revoked",
        to: user.email,
        locale: "ja",
        params: { tierName: "Supporter" },
      },
    });
    expect(providerMocks.resolveCheckoutByPaymentIntent).not.toHaveBeenCalled();
  });

  it("uses a distinct audit action for disputes", async () => {
    const { request } = await seedRequest({
      providerRef: "cs_dispute",
      providerPaymentRef: "pi_dispute",
    });

    await reverseAutoPayment("stripe", {
      type: "disputed",
      paymentRef: "pi_dispute",
      providerEventId: "evt_dispute",
    });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, request.id));
    expect(stored).toMatchObject({ status: "reversed", reversalEventId: "evt_dispute" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "payment_auto_disputed",
      beforeJson: { status: "pending_payment" },
      afterJson: expect.objectContaining({ kind: "disputed" }),
    });
    await expect(db.select().from(memberships)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("persists reversal-first, blocks a late paid grant, and keeps both replays idempotent", async () => {
    const { request } = await seedRequest({ providerRef: "cs_reversal_first" });
    providerMocks.resolveCheckoutByPaymentIntent.mockResolvedValue({
      providerRef: "cs_reversal_first",
      requestId: request.id,
      owned: true,
    });
    const reversal = {
      type: "refunded" as const,
      paymentRef: "pi_reversal_first",
      providerEventId: "evt_reversal_first",
    };
    const paid = {
      ...paidEvent("cs_reversal_first", "pi_reversal_first", request.id),
      providerEventId: "evt_paid_late",
    };

    await reverseAutoPayment("stripe", reversal);
    await reverseAutoPayment("stripe", reversal);
    await confirmAutoPayment("stripe", paid);
    await confirmAutoPayment("stripe", paid);

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, request.id));
    expect(stored).toMatchObject({
      status: "reversed",
      providerPaymentRef: "pi_reversal_first",
      reversalEventId: "evt_reversal_first",
      providerEventId: "evt_paid_late",
      grantedMembershipId: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("payment_auto_refunded");
    await expect(db.select().from(memberships)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
    expect(providerMocks.resolveCheckoutByPaymentIntent).toHaveBeenCalledOnce();
  });

  it("serializes concurrent paid and reversal processing to a reversed final state", async () => {
    const { request, tier } = await seedRequest({ providerRef: "cs_concurrent" });
    providerMocks.resolveCheckoutByPaymentIntent.mockResolvedValue({
      providerRef: "cs_concurrent",
      requestId: request.id,
      owned: true,
    });
    const [otherUser] = await db
      .insert(users)
      .values({ email: `other-${randomUUID()}@example.test` })
      .returning();
    const [otherMembership] = await db
      .insert(memberships)
      .values({
        userId: otherUser.id,
        tierId: tier.id,
        source: "manual",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        status: "active",
      })
      .returning();

    await Promise.all([
      confirmAutoPayment("stripe", {
        ...paidEvent("cs_concurrent", "pi_concurrent", request.id),
        providerEventId: "evt_paid_concurrent",
      }),
      reverseAutoPayment("stripe", {
        type: "refunded",
        paymentRef: "pi_concurrent",
        providerEventId: "evt_refund_concurrent",
      }),
    ]);

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const relatedMemberships = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, request.userId));
    const [untouched] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, otherMembership.id));

    expect(stored?.status).toBe("reversed");
    expect(relatedMemberships).toHaveLength(stored?.grantedMembershipId ? 1 : 0);
    if (relatedMemberships[0]) expect(relatedMemberships[0].status).toBe("revoked");
    expect(untouched).toMatchObject({ status: "active", version: 0 });
  });

  it("processes the same reversal event only once", async () => {
    const { request } = await seedRequest({
      providerRef: "cs_replay",
      providerPaymentRef: "pi_replay",
    });
    const event = {
      type: "refunded" as const,
      paymentRef: "pi_replay",
      providerEventId: "evt_replay",
    };

    await Promise.all([reverseAutoPayment("stripe", event), reverseAutoPayment("stripe", event)]);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, request.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("payment_auto_refunded");
  });

  it("enforces provider-scoped uniqueness for PaymentIntent mappings", async () => {
    await seedRequest({
      provider: "stripe",
      providerRef: "cs_unique_1",
      providerPaymentRef: "shared_external_id",
    });
    await expect(
      seedRequest({
        provider: "stripe",
        providerRef: "cs_unique_2",
        providerPaymentRef: "shared_external_id",
      }),
    ).rejects.toThrow();

    await expect(
      seedRequest({
        provider: "alipay",
        providerRef: "trade_unique",
        providerPaymentRef: "shared_external_id",
      }),
    ).resolves.toBeDefined();
  });

  it("ignores external PaymentIntents with no owned Checkout Session", async () => {
    const existing = await seedRequest({ providerRef: "cs_unrelated" });
    providerMocks.resolveCheckoutByPaymentIntent.mockResolvedValueOnce(null).mockResolvedValueOnce({
      providerRef: "cs_external",
      requestId: existing.request.id,
      owned: false,
    });

    await reverseAutoPayment("stripe", {
      type: "refunded",
      paymentRef: "pi_without_session",
      providerEventId: "evt_without_session",
    });
    await reverseAutoPayment("stripe", {
      type: "disputed",
      paymentRef: "pi_external",
      providerEventId: "evt_external",
    });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, existing.request.id));
    expect(stored).toMatchObject({ status: "pending_payment", reversalEventId: null });
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
  });

  it("returns a retryable error when an owned Checkout Session has no authoritative database binding", async () => {
    const { request } = await seedRequest({ providerRef: "cs_stored_reference" });
    providerMocks.resolveCheckoutByPaymentIntent.mockResolvedValue({
      providerRef: "cs_different_reference",
      requestId: request.id,
      owned: true,
    });

    await expect(
      reverseAutoPayment("stripe", {
        type: "refunded",
        paymentRef: "pi_reference_conflict",
        providerEventId: "evt_reference_conflict",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "paymentReversalTargetUnavailable",
    });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    expect(stored).toMatchObject({
      status: "pending_payment",
      providerPaymentRef: null,
      reversalEventId: null,
    });
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
  });

  it("returns a retryable error for an owned Checkout Session without a database row", async () => {
    providerMocks.resolveCheckoutByPaymentIntent.mockResolvedValue({
      providerRef: "cs_owned_missing",
      requestId: "11111111-1111-4111-8111-111111111111",
      owned: true,
    });

    await expect(
      reverseAutoPayment("stripe", {
        type: "refunded",
        paymentRef: "pi_owned_missing",
        providerEventId: "evt_owned_missing",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "paymentReversalTargetUnavailable",
    });
  });

  it("lazy-backfills a historical approved Checkout Session before reversing it", async () => {
    const { request } = await seedRequest({ providerRef: "cs_historical" });
    await confirmAutoPayment("stripe", {
      ...paidEvent("cs_historical", "pi_historical", request.id),
      providerEventId: "evt_historical_paid",
    });
    await db
      .update(paymentRequests)
      .set({ providerPaymentRef: null })
      .where(eq(paymentRequests.id, request.id));
    providerMocks.resolveCheckoutByPaymentIntent.mockResolvedValue({
      providerRef: "cs_historical",
      requestId: request.id,
      owned: false,
    });

    await reverseAutoPayment("stripe", {
      type: "refunded",
      paymentRef: "pi_historical",
      providerEventId: "evt_historical_refund",
    });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, stored!.grantedMembershipId!));
    expect(stored).toMatchObject({
      status: "reversed",
      providerPaymentRef: "pi_historical",
      reversalEventId: "evt_historical_refund",
    });
    expect(membership?.status).toBe("revoked");
  });

  it("treats a webhook after administrator reversal as a no-op", async () => {
    const { request } = await seedRequest({ providerRef: "cs_admin_reversed" });
    await confirmAutoPayment("stripe", {
      ...paidEvent("cs_admin_reversed", "pi_admin_reversed", request.id),
      providerEventId: "evt_admin_paid",
    });
    const [admin] = await db
      .insert(users)
      .values({ email: `admin-${randomUUID()}@example.test`, role: "admin" })
      .returning();
    await reversePaymentApproval(request.id, admin.id, "manual correction");

    await reverseAutoPayment("stripe", {
      type: "refunded",
      paymentRef: "pi_admin_reversed",
      providerEventId: "evt_after_manual",
    });

    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, request.id));
    const queued = await db.select().from(tasks);
    expect(events.filter((event) => event.action === "reverse")).toHaveLength(1);
    expect(events.filter((event) => event.action === "payment_auto_refunded")).toHaveLength(0);
    expect(queued.filter((task) => task.dedupeKey?.includes("membership_revoked"))).toHaveLength(0);
  });

  it("rolls back an approved reversal when its grant link is missing", async () => {
    const { request } = await seedRequest({
      status: "approved",
      providerRef: "cs_missing_grant",
      providerPaymentRef: "pi_missing_grant",
    });

    await expect(
      reverseAutoPayment("stripe", {
        type: "refunded",
        paymentRef: "pi_missing_grant",
        providerEventId: "evt_missing_grant",
      }),
    ).rejects.toMatchObject({ status: 409, code: "paymentGrantLinkMissing" });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    expect(stored).toMatchObject({
      status: "approved",
      reversalEventId: null,
    });
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("leaves rejected and cancelled requests unchanged", async () => {
    const rejected = await seedRequest({
      status: "rejected",
      providerRef: "cs_rejected",
      providerPaymentRef: "pi_rejected",
    });
    const cancelled = await seedRequest({
      status: "cancelled",
      providerRef: "cs_cancelled",
      providerPaymentRef: "pi_cancelled",
    });

    await reverseAutoPayment("stripe", {
      type: "refunded",
      paymentRef: "pi_rejected",
      providerEventId: "evt_rejected",
    });
    await reverseAutoPayment("stripe", {
      type: "disputed",
      paymentRef: "pi_cancelled",
      providerEventId: "evt_cancelled",
    });

    const [storedRejected] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, rejected.request.id));
    const [storedCancelled] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, cancelled.request.id));
    expect(storedRejected).toMatchObject({ status: "rejected", reversalEventId: null });
    expect(storedCancelled).toMatchObject({ status: "cancelled", reversalEventId: null });
    await expect(db.select().from(memberships)).resolves.toHaveLength(0);
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
  });
});
