import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  createSubscriptionCheckout: vi.fn(),
  getSubscriptionCheckoutState: vi.fn(),
  cancelSubscription: vi.fn(),
  retrieveSubscription: vi.fn(),
  listPaidSubscriptionInvoices: vi.fn(),
  resolveInvoiceByPaymentIntent: vi.fn(),
  getPaymentProvider: vi.fn(),
}));

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    getPaymentProvider: providerMocks.getPaymentProvider,
  };
});

import { getDb } from "@/db";
import {
  memberships,
  membershipTiers,
  paymentProviderEvents,
  paymentRequests,
  subscriptions,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { getActiveMembership, grantMembershipForPeriod } from "@/modules/membership";

import {
  applyPaidInvoice,
  applySubscriptionReversalOrTombstone,
  createSubscriptionCheckout,
  dispatchPaymentProviderEvent,
  persistPaymentProviderEvent,
  reconcileSubscriptions,
} from "./subscriptions";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("Stripe subscription integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    vi.clearAllMocks();
    providerMocks.getPaymentProvider.mockResolvedValue({
      id: "stripe",
      createSubscriptionCheckout: providerMocks.createSubscriptionCheckout,
      getSubscriptionCheckoutState: providerMocks.getSubscriptionCheckoutState,
      cancelSubscription: providerMocks.cancelSubscription,
      retrieveSubscription: providerMocks.retrieveSubscription,
      listPaidSubscriptionInvoices: providerMocks.listPaidSubscriptionInvoices,
      resolveInvoiceByPaymentIntent: providerMocks.resolveInvoiceByPaymentIntent,
    });
    providerMocks.createSubscriptionCheckout.mockResolvedValue({
      redirectUrl: "https://checkout.stripe.test/subscription",
      providerCheckoutRef: "cs_sub_1",
    });
    providerMocks.getSubscriptionCheckoutState.mockResolvedValue({
      status: "open",
      redirectUrl: "https://checkout.stripe.test/existing",
      providerSubscriptionRef: null,
    });
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seed() {
    const [user] = await db
      .insert(users)
      .values({ email: `subscriber-${randomUUID()}@example.test`, locale: "en" })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Monthly",
        slug: `monthly-${randomUUID()}`,
        priceLabel: "$9",
        priceAmountMinor: 900,
        currency: "usd",
        stripePriceId: "price_monthly_snapshot",
        level: 10,
        durationDays: 31,
      })
      .returning();
    return { user: user!, tier: tier! };
  }

  async function seedSubscription() {
    const { user, tier } = await seed();
    const [subscription] = await db
      .insert(subscriptions)
      .values({
        userId: user.id,
        tierId: tier.id,
        status: "pending",
        provider: "stripe",
        providerSubscriptionRef: "sub_123",
        providerPriceRef: "price_monthly_snapshot",
        expectedAmountMinor: 900,
        expectedCurrency: "usd",
        quantity: 1,
      })
      .returning();
    return { user, tier, subscription: subscription! };
  }

  function paidInvoiceEvent(overrides: Partial<Parameters<typeof applyPaidInvoice>[2]> = {}) {
    return {
      type: "subscription_renewed" as const,
      localSubscriptionId: "unused",
      providerSubscriptionRef: "sub_123",
      providerInvoiceRef: "in_123",
      providerPaymentRef: "pi_123",
      providerPriceRef: "price_monthly_snapshot",
      lines: [
        {
          providerPriceRef: "price_monthly_snapshot",
          periodStart: new Date("2026-02-01T00:00:00.000Z"),
          periodEnd: new Date("2026-03-01T00:00:00.000Z"),
          amountMinor: 900,
        },
      ],
      currency: "usd",
      providerEventId: "evt_invoice_paid",
      providerCreatedAt: new Date("2026-02-01T00:00:10.000Z"),
      ...overrides,
    };
  }

  it("grants a membership for the exact Stripe period without re-anchoring to now", async () => {
    const { user, tier } = await seed();
    const startsAt = new Date("2026-02-01T00:00:00.000Z");
    const endsAt = new Date("2026-03-01T00:00:00.000Z");

    const granted = await db.transaction((tx) =>
      grantMembershipForPeriod(
        {
          userId: user.id,
          tierId: tier.id,
          source: "payment_auto",
          startsAt,
          endsAt,
          actor: { type: "system", id: null },
        },
        tx,
      ),
    );

    expect(granted.membership.startsAt).toEqual(startsAt);
    expect(granted.membership.endsAt).toEqual(endsAt);
    await expect(getActiveMembership(user.id)).resolves.toBeNull();
  });

  it("applies a paid invoice once and grants only the paid period", async () => {
    const { user, subscription } = await seedSubscription();
    const event = paidInvoiceEvent({ localSubscriptionId: subscription.id });

    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", event));
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", event));

    const granted = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    const requests = await db.select().from(paymentRequests);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      startsAt: event.lines[0]!.periodStart,
      endsAt: event.lines[0]!.periodEnd,
      source: "payment_auto",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      status: "approved",
      providerInvoiceRef: event.providerInvoiceRef,
      grantedMembershipId: granted[0]!.id,
    });
  });

  it("rejects invoices unless exactly one line matches the subscription price snapshot", async () => {
    const { subscription } = await seedSubscription();
    const ambiguous = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      lines: [
        {
          providerPriceRef: "price_monthly_snapshot",
          periodStart: new Date("2026-02-01T00:00:00.000Z"),
          periodEnd: new Date("2026-03-01T00:00:00.000Z"),
          amountMinor: 900,
        },
        {
          providerPriceRef: "price_monthly_snapshot",
          periodStart: new Date("2026-03-01T00:00:00.000Z"),
          periodEnd: new Date("2026-04-01T00:00:00.000Z"),
          amountMinor: 900,
        },
      ],
    });

    await expect(
      db.transaction((tx) => applyPaidInvoice(tx, "stripe", ambiguous)),
    ).rejects.toMatchObject({
      status: 422,
      code: "stripeInvoiceLineAmbiguous",
    });
  });

  it("keeps a reversal-first invoice tombstone from granting later paid events", async () => {
    const { user, subscription } = await seedSubscription();
    const event = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_refund_first",
    });

    await db.transaction((tx) =>
      applySubscriptionReversalOrTombstone(tx, "stripe", {
        type: "refunded",
        paymentRef: "pi_refund_first",
        providerInvoiceRef: event.providerInvoiceRef,
        providerEventId: "evt_refund_first",
        providerCreatedAt: new Date("2026-01-31T23:59:00.000Z"),
        localSubscriptionId: subscription.id,
      } as never),
    );
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", event));

    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(0);
    const [request] = await db.select().from(paymentRequests);
    expect(request).toMatchObject({
      status: "reversed",
      providerInvoiceRef: event.providerInvoiceRef,
      reversalEventId: "evt_refund_first",
    });
  });

  it("deduplicates non-terminal subscriptions for provider NULL as well as Stripe", async () => {
    const { user, tier } = await seed();
    await db.insert(subscriptions).values({
      userId: user.id,
      tierId: tier.id,
      status: "pending",
      provider: null,
    });
    await expect(
      db.insert(subscriptions).values({
        userId: user.id,
        tierId: tier.id,
        status: "pending",
        provider: null,
      }),
    ).rejects.toThrow();

    await db
      .update(subscriptions)
      .set({ status: "expired" })
      .where(eq(subscriptions.userId, user.id));
    await expect(
      db.insert(subscriptions).values({
        userId: user.id,
        tierId: tier.id,
        status: "pending",
        provider: null,
      }),
    ).resolves.toBeDefined();
  });

  it("returns one open subscription checkout for concurrent double-clicks", async () => {
    const { user, tier } = await seed();
    const input = {
      userId: user.id,
      tierId: tier.id,
      successUrl: "https://site.test/success",
      cancelUrl: "https://site.test/cancel",
    };

    const [first, second] = await Promise.all([
      createSubscriptionCheckout(input),
      createSubscriptionCheckout(input),
    ]);

    expect(first.redirectUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(second.redirectUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(providerMocks.createSubscriptionCheckout).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerCheckoutRef: "cs_sub_1",
      providerPriceRef: "price_monthly_snapshot",
      expectedAmountMinor: 900,
      expectedCurrency: "usd",
    });
  });

  it("persists inbox events and dispatches the claimed event exactly once", async () => {
    const { user, subscription } = await seedSubscription();
    const event = paidInvoiceEvent({ localSubscriptionId: subscription.id });
    await persistPaymentProviderEvent("stripe", event);
    const [eventRow] = await db
      .select({ id: paymentProviderEvents.id })
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, event.providerEventId));
    await Promise.all([
      dispatchPaymentProviderEvent(eventRow!.id),
      dispatchPaymentProviderEvent(eventRow!.id),
    ]);

    const granted = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    const [inbox] = await db.select().from(paymentProviderEvents);
    expect(granted).toHaveLength(1);
    expect(inbox).toMatchObject({
      providerEventId: event.providerEventId,
      status: "processed",
      attempts: 1,
    });
  });

  it("recovers a missing pending subscription through its checkout and paid invoice", async () => {
    const { user, tier } = await seed();
    const [subscription] = await db
      .insert(subscriptions)
      .values({
        userId: user.id,
        tierId: tier.id,
        status: "pending",
        provider: "stripe",
        providerCheckoutRef: "cs_missing_webhooks",
        providerPriceRef: "price_monthly_snapshot",
        expectedAmountMinor: 900,
        expectedCurrency: "usd",
        quantity: 1,
      })
      .returning();
    const invoice = paidInvoiceEvent({
      localSubscriptionId: subscription!.id,
      providerSubscriptionRef: "sub_recovered",
      providerInvoiceRef: "in_recovered",
    });
    providerMocks.getSubscriptionCheckoutState.mockResolvedValue({
      status: "complete",
      redirectUrl: null,
      providerSubscriptionRef: "sub_recovered",
    });
    providerMocks.retrieveSubscription.mockResolvedValue({
      status: "active",
      providerSubscriptionRef: "sub_recovered",
      providerCustomerRef: "cus_recovered",
      currentPeriodEndsAt: invoice.lines[0]!.periodEnd,
      cancelAtPeriodEnd: false,
    });
    providerMocks.listPaidSubscriptionInvoices.mockResolvedValue([invoice]);

    await expect(reconcileSubscriptions()).resolves.toBe(1);

    const [updated] = await db.select().from(subscriptions);
    expect(updated).toMatchObject({
      providerSubscriptionRef: "sub_recovered",
      providerCustomerRef: "cus_recovered",
      status: "active",
    });
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(1);
  });

  it("marks an abandoned checkout expired and stops remote subscription reconciliation", async () => {
    const { user, tier } = await seed();
    await db.insert(subscriptions).values({
      userId: user.id,
      tierId: tier.id,
      status: "pending",
      provider: "stripe",
      providerCheckoutRef: "cs_abandoned",
      providerPriceRef: "price_monthly_snapshot",
      expectedAmountMinor: 900,
      expectedCurrency: "usd",
      quantity: 1,
    });
    providerMocks.getSubscriptionCheckoutState.mockResolvedValue({
      status: "expired",
      redirectUrl: null,
      providerSubscriptionRef: null,
    });

    await expect(reconcileSubscriptions()).resolves.toBe(1);

    const [updated] = await db.select().from(subscriptions);
    expect(updated?.status).toBe("expired");
    expect(providerMocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(providerMocks.listPaidSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it("deduplicates a webhook racing reconciliation for the same paid invoice", async () => {
    const { user, subscription } = await seedSubscription();
    const event = paidInvoiceEvent({ localSubscriptionId: subscription.id });
    providerMocks.retrieveSubscription.mockResolvedValue({
      status: "active",
      providerSubscriptionRef: subscription.providerSubscriptionRef!,
      providerCustomerRef: "cus_race",
      currentPeriodEndsAt: event.lines[0]!.periodEnd,
      cancelAtPeriodEnd: false,
    });
    providerMocks.listPaidSubscriptionInvoices.mockResolvedValue([event]);
    await persistPaymentProviderEvent("stripe", event);
    const [eventRow] = await db.select().from(paymentProviderEvents);

    await Promise.all([reconcileSubscriptions(), dispatchPaymentProviderEvent(eventRow!.id)]);

    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(paymentRequests)
        .where(eq(paymentRequests.providerInvoiceRef, event.providerInvoiceRef)),
    ).resolves.toHaveLength(1);
  });

  it("recovers a missing paid period for a recently canceled subscription", async () => {
    const { user, subscription } = await seedSubscription();
    await db
      .update(subscriptions)
      .set({ status: "canceled", canceledAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
    const event = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_canceled_missing",
    });
    providerMocks.retrieveSubscription.mockResolvedValue({
      status: "canceled",
      providerSubscriptionRef: subscription.providerSubscriptionRef!,
      providerCustomerRef: "cus_canceled",
      currentPeriodEndsAt: event.lines[0]!.periodEnd,
      cancelAtPeriodEnd: false,
    });
    providerMocks.listPaidSubscriptionInvoices.mockResolvedValue([event]);

    await expect(reconcileSubscriptions()).resolves.toBe(1);
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(1);
  });

  it("dispatches identical provider event ids independently by inbox row UUID", async () => {
    const providerEventId = `evt_shared_${randomUUID()}`;
    const event = {
      type: "ignored" as const,
      providerEventId,
      providerCreatedAt: new Date(),
    };

    await persistPaymentProviderEvent("stripe", event);
    await persistPaymentProviderEvent("other-provider", event);

    const rows = await db.select().from(paymentProviderEvents);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.provider).sort()).toEqual(["other-provider", "stripe"]);

    await Promise.all(
      rows.flatMap((row) => [
        dispatchPaymentProviderEvent(row.id),
        dispatchPaymentProviderEvent(row.id),
      ]),
    );

    const dispatched = await db.select().from(paymentProviderEvents);
    expect(dispatched).toHaveLength(2);
    expect(dispatched.every((row) => row.status === "processed" && row.attempts === 1)).toBe(true);

    const dispatchTasks = (await db.select().from(tasks)).filter(
      (task) => task.kind === "payment_provider_event.dispatch",
    );
    expect(dispatchTasks).toHaveLength(2);
    expect(new Set(dispatchTasks.map((task) => task.dedupeKey)).size).toBe(2);
  });
});
