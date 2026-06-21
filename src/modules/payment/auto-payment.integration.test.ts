import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  createCheckout: vi.fn(),
  getCheckoutState: vi.fn(),
  getPaymentProvider: vi.fn(),
}));

vi.mock("./providers", () => ({
  getPaymentProvider: providerMocks.getPaymentProvider,
}));

import { getDb } from "@/db";
import {
  auditEvents,
  files,
  memberships,
  membershipTiers,
  paymentRequests,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { grantMembership } from "@/modules/membership";

import {
  approvePaymentRequest,
  confirmAutoPayment,
  createAutoCheckout,
  createPaymentRequest,
  expireAutoPayment,
  resubmitPaymentProof,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("Stripe automatic payment integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    vi.clearAllMocks();
    providerMocks.getPaymentProvider.mockResolvedValue({
      id: "stripe",
      createCheckout: providerMocks.createCheckout,
      getCheckoutState: providerMocks.getCheckoutState,
    });
    providerMocks.createCheckout.mockResolvedValue({
      redirectUrl: "https://checkout.stripe.test/session",
      providerRef: "cs_test_123",
    });
    providerMocks.getCheckoutState.mockResolvedValue({
      status: "open",
      redirectUrl: "https://checkout.stripe.test/existing",
    });
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seed(priceAmountMinor: number | null = 500, currency: string | null = "usd") {
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
        priceAmountMinor,
        currency,
        level: 10,
        durationDays: 31,
      })
      .returning();
    return { user: user!, tier: tier! };
  }

  it("requires structured payable tier data", async () => {
    const { user, tier } = await seed(null, null);
    await expect(
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
    ).rejects.toMatchObject({ status: 400, code: "tierNotPayable" });
    expect(providerMocks.getPaymentProvider).not.toHaveBeenCalled();
  });

  it("creates a pending auto request and records the Stripe session reference", async () => {
    const { user, tier } = await seed();
    await expect(
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
    ).resolves.toEqual({ redirectUrl: "https://checkout.stripe.test/session" });

    const [request] = await db.select().from(paymentRequests);
    expect(request).toMatchObject({
      userId: user.id,
      tierId: tier.id,
      flow: "auto",
      status: "pending_payment",
      provider: "stripe",
      providerRef: "cs_test_123",
      amountMinor: 500,
      currency: "usd",
    });
    expect(providerMocks.createCheckout).toHaveBeenCalledWith({
      requestId: request!.id,
      amountMinor: 500,
      currency: "usd",
      tierName: "Supporter",
      successUrl: "https://site.test/success",
      cancelUrl: "https://site.test/cancel",
    });
  });

  it("rejects auto checkout when a manual pending request already exists", async () => {
    const { user, tier } = await seed();
    await createPaymentRequest({ userId: user.id, tierId: tier.id });

    await expect(
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
    ).rejects.toMatchObject({ status: 400, code: "pendingPaymentExists" });
    expect(providerMocks.createCheckout).not.toHaveBeenCalled();
    await expect(db.select().from(paymentRequests)).resolves.toHaveLength(1);
  });

  it("serializes manual and automatic creation to one pending request", async () => {
    const { user, tier } = await seed();
    const autoInput = {
      userId: user.id,
      tierId: tier.id,
      successUrl: "https://site.test/success",
      cancelUrl: "https://site.test/cancel",
    };
    const results = await Promise.allSettled([
      createPaymentRequest({ userId: user.id, tierId: tier.id }),
      createAutoCheckout(autoInput),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 400, code: "pendingPaymentExists" });
    const rows = await db.select().from(paymentRequests);
    expect(rows).toHaveLength(1);
    expect(["pending_review", "pending_payment"]).toContain(rows[0]!.status);
  });

  it("serializes automatic creation against rejected-proof resubmission", async () => {
    const { user, tier } = await seed();
    const [rejected] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "manual",
        status: "rejected",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();
    const [proof] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        objectKey: `proof-${randomUUID()}`,
        originalName: "proof.png",
        mimeType: "image/png",
        sizeBytes: 128,
        purpose: "payment_proof",
        createdBy: user.id,
      })
      .returning();
    const results = await Promise.allSettled([
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
      resubmitPaymentProof({
        requestId: rejected.id,
        userId: user.id,
        proofFileId: proof.id,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toMatchObject({ status: 400, code: "pendingPaymentExists" });
    const pending = (await db.select().from(paymentRequests)).filter((request) =>
      ["pending_review", "pending_payment"].includes(request.status),
    );
    expect(pending).toHaveLength(1);
  });

  it("keeps one row when two auto checkouts race", async () => {
    const { user, tier } = await seed();
    let releaseCheckout!: () => void;
    let markStarted!: () => void;
    const release = new Promise<void>((resolve) => (releaseCheckout = resolve));
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    providerMocks.createCheckout.mockImplementationOnce(async () => {
      markStarted();
      await release;
      return {
        redirectUrl: "https://checkout.stripe.test/race",
        providerRef: "cs_race",
      };
    });
    const input = {
      userId: user.id,
      tierId: tier.id,
      successUrl: "https://site.test/success",
      cancelUrl: "https://site.test/cancel",
    };
    const first = createAutoCheckout(input);
    await started;
    await expect(createAutoCheckout(input)).rejects.toMatchObject({
      status: 409,
      code: "paymentCheckoutChanged",
    });
    releaseCheckout();
    await expect(first).resolves.toEqual({ redirectUrl: "https://checkout.stripe.test/race" });
    await expect(db.select().from(paymentRequests)).resolves.toHaveLength(1);
  });

  it("keeps a failed checkout request retryable without creating duplicate rows", async () => {
    const { user, tier } = await seed();
    providerMocks.createCheckout
      .mockRejectedValueOnce(new Error("Stripe unavailable"))
      .mockResolvedValueOnce({
        redirectUrl: "https://checkout.stripe.test/retry",
        providerRef: "cs_retry",
      });
    const input = {
      userId: user.id,
      tierId: tier.id,
      successUrl: "https://site.test/success",
      cancelUrl: "https://site.test/cancel",
    };

    await expect(createAutoCheckout(input)).rejects.toThrow("Stripe unavailable");
    const [failed] = await db.select().from(paymentRequests);
    expect(failed).toMatchObject({
      status: "pending_payment",
      providerRef: null,
    });

    await expect(createAutoCheckout(input)).resolves.toEqual({
      redirectUrl: "https://checkout.stripe.test/retry",
    });
    const rows = await db.select().from(paymentRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: failed!.id, providerRef: "cs_retry" });
    expect(providerMocks.createCheckout).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requestId: failed!.id }),
    );
    expect(providerMocks.createCheckout).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestId: failed!.id }),
    );
  });

  it("reuses an existing open Stripe session instead of creating a duplicate", async () => {
    const { user, tier } = await seed();
    await db.insert(paymentRequests).values({
      userId: user.id,
      tierId: tier.id,
      flow: "auto",
      status: "pending_payment",
      provider: "stripe",
      providerRef: "cs_existing",
      amountMinor: 500,
      currency: "usd",
      amountLabel: tier.priceLabel,
      durationDays: tier.durationDays,
    });

    await expect(
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
    ).resolves.toEqual({
      redirectUrl: "https://checkout.stripe.test/existing",
    });
    expect(providerMocks.getCheckoutState).toHaveBeenCalledWith("cs_existing");
    expect(providerMocks.createCheckout).not.toHaveBeenCalled();
    await expect(db.select().from(paymentRequests)).resolves.toHaveLength(1);
  });

  it("rejects a fresh in-progress checkout claim", async () => {
    const { user, tier } = await seed();
    await db.insert(paymentRequests).values({
      userId: user.id,
      tierId: tier.id,
      flow: "auto",
      status: "pending_payment",
      provider: "stripe",
      providerRef: "creating:in-flight",
      amountMinor: 500,
      currency: "usd",
      amountLabel: tier.priceLabel,
      durationDays: tier.durationDays,
    });

    await expect(
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
    ).rejects.toMatchObject({ status: 409, code: "paymentCheckoutChanged" });
    expect(providerMocks.getCheckoutState).not.toHaveBeenCalled();
    expect(providerMocks.createCheckout).not.toHaveBeenCalled();
  });

  it("reclaims a stale checkout claim with the original request id", async () => {
    const { user, tier } = await seed();
    const [stale] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "creating:abandoned",
        amountMinor: 500,
        currency: "usd",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
        updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      })
      .returning();

    await expect(
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
    ).resolves.toEqual({ redirectUrl: "https://checkout.stripe.test/session" });

    const rows = await db.select().from(paymentRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: stale!.id,
      status: "pending_payment",
      providerRef: "cs_test_123",
    });
    expect(providerMocks.createCheckout).toHaveBeenCalledOnce();
    expect(providerMocks.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: stale!.id }),
    );
    expect(providerMocks.getCheckoutState).not.toHaveBeenCalled();
  });

  it("cancels an expired Stripe session and creates one replacement request", async () => {
    const { user, tier } = await seed();
    const [expired] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "cs_expired",
        amountMinor: 500,
        currency: "usd",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();
    providerMocks.getCheckoutState.mockResolvedValueOnce({
      status: "expired",
      redirectUrl: null,
    });

    await expect(
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
    ).resolves.toEqual({ redirectUrl: "https://checkout.stripe.test/session" });

    const rows = await db.select().from(paymentRequests).orderBy(paymentRequests.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: expired!.id, status: "cancelled" });
    expect(rows[1]).toMatchObject({
      status: "pending_payment",
      providerRef: "cs_test_123",
    });
  });

  it("waits for the webhook when Stripe reports a completed session", async () => {
    const { user, tier } = await seed();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "cs_complete",
        amountMinor: 500,
        currency: "usd",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();
    providerMocks.getCheckoutState.mockResolvedValueOnce({
      status: "complete",
      redirectUrl: null,
    });

    await expect(
      createAutoCheckout({
        userId: user.id,
        tierId: tier.id,
        successUrl: "https://site.test/success",
        cancelUrl: "https://site.test/cancel",
      }),
    ).rejects.toMatchObject({ status: 400, code: "pendingAutoPaymentExists" });

    expect(providerMocks.createCheckout).not.toHaveBeenCalled();
    const rows = await db.select().from(paymentRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: request!.id,
      status: "pending_payment",
      providerRef: "cs_complete",
    });
  });

  it("cancels an abandoned request when Stripe sends a signed expiration event", async () => {
    const { user, tier } = await seed();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "cs_expired_webhook",
        amountMinor: 500,
        currency: "usd",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();
    const event = {
      type: "expired" as const,
      providerRef: "cs_expired_webhook",
      providerEventId: "evt_expired_webhook",
    };

    await expireAutoPayment("stripe", event);
    await expireAutoPayment("stripe", event);

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request!.id));
    expect(stored).toMatchObject({
      status: "cancelled",
      providerEventId: "evt_expired_webhook",
      grantedMembershipId: null,
    });
    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, request!.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "payment_auto_expired",
      actorType: "system",
      beforeJson: { status: "pending_payment" },
      afterJson: {
        status: "cancelled",
        provider: "stripe",
        providerEventId: "evt_expired_webhook",
      },
    });
    await expect(db.select().from(memberships)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("serializes automatic confirmation with manual approval for the same user", async () => {
    const { user, tier } = await seed();
    const [admin] = await db
      .insert(users)
      .values({ email: `admin-${randomUUID()}@example.test`, role: "admin" })
      .returning();
    const [manualTier] = await db
      .insert(membershipTiers)
      .values({
        name: "Manual alternate",
        slug: `manual-alt-${randomUUID()}`,
        priceLabel: "$5",
        level: tier.level,
        durationDays: 31,
      })
      .returning();
    const [manualRequest] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: manualTier.id,
        flow: "manual",
        status: "pending_review",
        amountLabel: manualTier.priceLabel,
        durationDays: manualTier.durationDays,
      })
      .returning();
    await db.insert(paymentRequests).values({
      userId: user.id,
      tierId: tier.id,
      flow: "auto",
      status: "pending_payment",
      provider: "stripe",
      providerRef: "cs_concurrent_auto_manual",
      amountMinor: 500,
      currency: "usd",
      amountLabel: tier.priceLabel,
      durationDays: tier.durationDays,
    });

    await Promise.all([
      approvePaymentRequest(manualRequest.id, admin.id),
      confirmAutoPayment("stripe", {
        type: "paid",
        providerRef: "cs_concurrent_auto_manual",
        paymentRef: "pi_concurrent_auto_manual",
        providerEventId: "evt_concurrent_auto_manual",
        amountMinor: 500,
        currency: "usd",
      }),
    ]);
    const grants = (
      await db.select().from(memberships).where(eq(memberships.userId, user.id))
    ).sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
    expect(grants).toHaveLength(2);
    expect(grants[1]!.startsAt.toISOString()).toBe(grants[0]!.endsAt.toISOString());
  });

  it("serializes an administrator grant with automatic payment confirmation", async () => {
    const { user, tier } = await seed();
    await db.insert(paymentRequests).values({
      userId: user.id,
      tierId: tier.id,
      flow: "auto",
      status: "pending_payment",
      provider: "stripe",
      providerRef: "cs_concurrent_admin_auto",
      amountMinor: 500,
      currency: "usd",
      amountLabel: tier.priceLabel,
      durationDays: tier.durationDays,
    });

    await Promise.all([
      grantMembership({
        userId: user.id,
        tierId: tier.id,
        source: "manual",
        actor: { type: "system", id: null },
      }),
      confirmAutoPayment("stripe", {
        type: "paid",
        providerRef: "cs_concurrent_admin_auto",
        paymentRef: "pi_concurrent_admin_auto",
        providerEventId: "evt_concurrent_admin_auto",
        amountMinor: 500,
        currency: "usd",
      }),
    ]);
    const grants = (
      await db.select().from(memberships).where(eq(memberships.userId, user.id))
    ).sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
    expect(grants).toHaveLength(2);
    expect(grants[1]!.startsAt.toISOString()).toBe(grants[0]!.endsAt.toISOString());
  });

  it("confirms once and commits membership, audit, and email outbox atomically", async () => {
    const { user, tier } = await seed();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "cs_paid",
        amountMinor: 500,
        currency: "usd",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();
    const event = {
      type: "paid" as const,
      providerRef: "cs_paid",
      paymentRef: "pi_paid",
      providerEventId: "evt_paid",
      amountMinor: 500,
      currency: "usd",
    };

    await Promise.all([confirmAutoPayment("stripe", event), confirmAutoPayment("stripe", event)]);

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request!.id));
    const grants = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, request!.id));
    const [paymentEvent] = events.filter((entry) => entry.action === "payment_auto_paid");
    const [grantEvent] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "membership"), eq(auditEvents.action, "grant")));
    const queued = await db.select().from(tasks);

    expect(stored).toMatchObject({
      status: "approved",
      providerEventId: "evt_paid",
      providerPaymentRef: "pi_paid",
      grantedMembershipId: grants[0]?.id,
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ source: "payment_auto", status: "active" });
    expect(paymentEvent).toMatchObject({ actorType: "system" });
    expect(grantEvent).toMatchObject({
      correlationId: paymentEvent?.correlationId,
      causationId: paymentEvent?.id,
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      dedupeKey: `email:membership_activated:${request!.id}`,
      payloadJson: {
        template: "membership_activated",
        to: user.email,
        locale: "ja",
      },
    });
  });

  it("treats non-pending replay as a no-op", async () => {
    const { user, tier } = await seed();
    await db.insert(paymentRequests).values({
      userId: user.id,
      tierId: tier.id,
      flow: "auto",
      status: "cancelled",
      provider: "stripe",
      providerRef: "cs_cancelled",
      amountMinor: 500,
      currency: "usd",
      amountLabel: tier.priceLabel,
      durationDays: tier.durationDays,
    });
    await confirmAutoPayment("stripe", {
      type: "paid",
      providerRef: "cs_cancelled",
      paymentRef: "pi_cancelled",
      providerEventId: "evt_late",
      amountMinor: 500,
      currency: "usd",
    });
    await expect(db.select().from(memberships)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("rejects conflicting Checkout Session metadata without granting access", async () => {
    const { user, tier } = await seed();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "cs_reference_conflict",
        amountMinor: 500,
        currency: "usd",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();

    await expect(
      confirmAutoPayment("stripe", {
        type: "paid",
        providerRef: "cs_reference_conflict",
        paymentRef: "pi_reference_conflict",
        requestId: randomUUID(),
        providerEventId: "evt_reference_conflict",
        amountMinor: 500,
        currency: "usd",
      }),
    ).rejects.toMatchObject({ status: 409, code: "paymentReferenceMismatch" });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request!.id));
    expect(stored).toMatchObject({
      status: "pending_payment",
      providerEventId: null,
      providerPaymentRef: null,
      grantedMembershipId: null,
    });
    await expect(db.select().from(memberships)).resolves.toHaveLength(0);
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });

  it("rejects amount mismatch without changing payment or granting access", async () => {
    const { user, tier } = await seed();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "cs_mismatch",
        amountMinor: 500,
        currency: "usd",
        amountLabel: tier.priceLabel,
        durationDays: tier.durationDays,
      })
      .returning();

    await expect(
      confirmAutoPayment("stripe", {
        type: "paid",
        providerRef: "cs_mismatch",
        paymentRef: "pi_mismatch",
        providerEventId: "evt_mismatch",
        amountMinor: 499,
        currency: "usd",
      }),
    ).rejects.toMatchObject({ status: 409, code: "paymentAmountMismatch" });

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request!.id));
    expect(stored).toMatchObject({
      status: "pending_payment",
      providerEventId: null,
      grantedMembershipId: null,
    });
    await expect(db.select().from(memberships)).resolves.toHaveLength(0);
    await expect(db.select().from(auditEvents)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });
});
