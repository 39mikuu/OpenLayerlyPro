import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #112 — regression guard for the reconcile / webhook clock ordering fix
 * (defect reproduced under #102).
 *
 * Clock model — a single provider (Stripe) clock domain:
 * - webhook ordering uses `providerCreatedAt` (provider event time, whole seconds);
 * - reconcile advances `statusEventAt` to `retrieveSubscription().observedAt`, a
 *   provider-clock fence through the end of the Stripe response Date second.
 *
 * Because Stripe event.created and the HTTP Date header are both second-granularity,
 * their order inside one second is unknowable. The deterministic fail-closed policy is
 * therefore: the provider observation wins the represented second; a same-second
 * webhook cannot directly overwrite it and the next provider reconciliation converges
 * any genuinely later same-second change. A webhook from the next provider second is
 * still accepted normally. Missing observation timestamps never fall back to local
 * time. Tests drive real production functions against real PostgreSQL.
 */

const providerMocks = vi.hoisted(() => ({
  getSubscriptionCheckoutState: vi.fn(),
  retrieveSubscription: vi.fn(),
  listPaidSubscriptionInvoices: vi.fn(),
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
import { membershipTiers, paymentProviderEvents, subscriptions, users } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import {
  dispatchPaymentProviderEvent,
  persistPaymentProviderEvent,
  reconcileSubscriptions,
} from "./subscriptions";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const T0 = new Date("2026-01-01T00:00:00.000Z"); // stale statusEventAt on the seeded row
const DELAYED = new Date("2026-01-10T00:00:00.000Z"); // stale webhook (T0 < DELAYED)
const OBSERVED_SECOND = new Date("2026-01-20T00:00:00.000Z");
const OBSERVED_FENCE = new Date("2026-01-20T00:00:00.999Z");
const NEXT_SECOND = new Date("2026-01-20T00:00:01.000Z");
const NEXT_OBSERVATION_FENCE = new Date("2026-01-20T00:00:01.999Z");
const LATE = new Date("2026-03-01T00:00:00.000Z"); // a fence already newer than observation
const PERIOD_END = new Date("2026-02-01T00:00:00.000Z");

describeWithDatabase("issue #112 reconcile fence ordering (single provider clock domain)", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
    vi.clearAllMocks();
    providerMocks.getPaymentProvider.mockResolvedValue({
      id: "stripe",
      getSubscriptionCheckoutState: providerMocks.getSubscriptionCheckoutState,
      retrieveSubscription: providerMocks.retrieveSubscription,
      listPaidSubscriptionInvoices: providerMocks.listPaidSubscriptionInvoices,
    });
    // Production getPaymentProvider normalizes Stripe's second-granularity HTTP Date
    // into an end-of-second provider observation fence. This mock returns that
    // normalized contract directly.
    providerMocks.retrieveSubscription.mockResolvedValue({
      status: "active",
      providerSubscriptionRef: "sub_123",
      providerCustomerRef: "cus_123",
      currentPeriodEndsAt: PERIOD_END,
      cancelAtPeriodEnd: false,
      observedAt: OBSERVED_FENCE,
    });
    providerMocks.listPaidSubscriptionInvoices.mockResolvedValue([]);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seedSubscription(overrides: Partial<typeof subscriptions.$inferInsert> = {}) {
    const [user] = await db
      .insert(users)
      .values({ email: `sub-${randomUUID()}@example.test`, locale: "en" })
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
    const [subscription] = await db
      .insert(subscriptions)
      .values({
        userId: user!.id,
        tierId: tier!.id,
        status: "past_due",
        provider: "stripe",
        providerSubscriptionRef: "sub_123",
        providerPriceRef: "price_monthly_snapshot",
        providerCustomerRef: "cus_123",
        expectedAmountMinor: 900,
        expectedCurrency: "usd",
        quantity: 1,
        currentPeriodEndsAt: new Date("2025-12-01T00:00:00.000Z"),
        statusEventAt: T0,
        ...overrides,
      })
      .returning();
    return subscription!;
  }

  async function dispatchEvent(event: Record<string, unknown> & { providerEventId: string }) {
    await persistPaymentProviderEvent("stripe", event as never);
    const [row] = await db
      .select({ id: paymentProviderEvents.id })
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, event.providerEventId));
    await dispatchPaymentProviderEvent(row!.id);
  }

  function paymentFailedEvent(providerCreatedAt: Date, subId: string) {
    return {
      type: "subscription_payment_failed",
      localSubscriptionId: subId,
      providerSubscriptionRef: "sub_123",
      providerInvoiceRef: null,
      providerEventId: `evt_failed_${randomUUID()}`,
      providerCreatedAt,
    };
  }

  function canceledEvent(providerCreatedAt: Date) {
    return {
      type: "subscription_canceled",
      providerSubscriptionRef: "sub_123",
      canceledAt: providerCreatedAt,
      providerEventId: `evt_canceled_${randomUUID()}`,
      providerCreatedAt,
    };
  }

  function renewedInvoice(providerCreatedAt: Date, periodEnd: Date, subId: string) {
    return {
      type: "subscription_renewed" as const,
      localSubscriptionId: subId,
      providerSubscriptionRef: "sub_123",
      providerInvoiceRef: `in_${randomUUID()}`,
      providerPaymentRef: `pi_${randomUUID()}`,
      providerPriceRef: "price_monthly_snapshot",
      lines: [
        {
          providerPriceRef: "price_monthly_snapshot",
          periodStart: new Date(periodEnd.getTime() - 31 * 24 * 60 * 60 * 1000),
          periodEnd,
          amountMinor: 900,
        },
      ],
      currency: "usd",
      providerEventId: `evt_inv_${randomUUID()}`,
      providerCreatedAt,
    };
  }

  it("advances statusEventAt through the provider observation second", async () => {
    const seeded = await seedSubscription();

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.statusEventAt).toEqual(OBSERVED_FENCE);
    expect(row!.currentPeriodEndsAt).toEqual(PERIOD_END);
  });

  it("rejects a delayed payment_failed webhook created before the observation", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();

    await dispatchEvent(paymentFailedEvent(DELAYED, seeded.id));

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.currentPeriodEndsAt).toEqual(PERIOD_END);
  });

  it("rejects a delayed canceled webhook created before the observation", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();

    await dispatchEvent(canceledEvent(DELAYED));

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
  });

  it("accepts a genuinely newer webhook from the next provider second", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();

    await dispatchEvent(canceledEvent(NEXT_SECOND));

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("canceled");
    expect(row!.statusEventAt).toEqual(NEXT_SECOND);
  });

  it("does not let an ambiguous same-second webhook directly overwrite the observation", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();

    await dispatchEvent(canceledEvent(OBSERVED_SECOND));

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.statusEventAt).toEqual(OBSERVED_FENCE);
  });

  it("converges a genuinely later same-second change on the next provider observation", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();
    await dispatchEvent(canceledEvent(OBSERVED_SECOND));

    providerMocks.retrieveSubscription.mockResolvedValue({
      status: "canceled",
      providerSubscriptionRef: "sub_123",
      providerCustomerRef: "cus_123",
      currentPeriodEndsAt: PERIOD_END,
      cancelAtPeriodEnd: false,
      observedAt: NEXT_OBSERVATION_FENCE,
    });
    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("canceled");
    expect(row!.statusEventAt).toEqual(NEXT_OBSERVATION_FENCE);
  });

  it("in-flight NEWER webhook from the next second survives the reconcile write", async () => {
    const seeded = await seedSubscription();
    providerMocks.retrieveSubscription.mockImplementation(async () => {
      await dispatchEvent(canceledEvent(NEXT_SECOND));
      return {
        status: "active",
        providerSubscriptionRef: "sub_123",
        providerCustomerRef: "cus_123",
        currentPeriodEndsAt: PERIOD_END,
        cancelAtPeriodEnd: false,
        observedAt: OBSERVED_FENCE,
      };
    });

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("canceled");
    expect(row!.statusEventAt).toEqual(NEXT_SECOND);
  });

  it("in-flight same-second webhook loses to the provider observation fence", async () => {
    const seeded = await seedSubscription();
    providerMocks.retrieveSubscription.mockImplementation(async () => {
      await dispatchEvent(canceledEvent(OBSERVED_SECOND));
      return {
        status: "active",
        providerSubscriptionRef: "sub_123",
        providerCustomerRef: "cus_123",
        currentPeriodEndsAt: PERIOD_END,
        cancelAtPeriodEnd: false,
        observedAt: OBSERVED_FENCE,
      };
    });

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.statusEventAt).toEqual(OBSERVED_FENCE);
  });

  it("fails closed and skips the fence write when the provider gives no observedAt", async () => {
    const seeded = await seedSubscription();
    providerMocks.retrieveSubscription.mockResolvedValue({
      status: "active",
      providerSubscriptionRef: "sub_123",
      providerCustomerRef: "cus_123",
      currentPeriodEndsAt: PERIOD_END,
      cancelAtPeriodEnd: false,
      observedAt: null,
    });

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("past_due");
    expect(row!.statusEventAt).toEqual(T0);
  });

  it("does not let an older reconciled paid invoice regress a newer status fence", async () => {
    const seeded = await seedSubscription({
      status: "active",
      statusEventAt: LATE,
      currentPeriodEndsAt: PERIOD_END,
    });
    providerMocks.listPaidSubscriptionInvoices.mockResolvedValue([
      renewedInvoice(DELAYED, new Date("2026-01-06T00:00:00.000Z"), seeded.id),
    ]);

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.statusEventAt).toEqual(LATE);
    expect(row!.currentPeriodEndsAt).toEqual(PERIOD_END);
  });
});
