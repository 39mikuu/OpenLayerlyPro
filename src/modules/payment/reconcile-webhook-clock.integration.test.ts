import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #112 — regression guard for the reconcile / webhook clock ordering fix
 * (defect reproduced under #102).
 *
 * Clock model — a single provider (Stripe) clock domain:
 * - webhook ordering uses `providerCreatedAt` (provider event time);
 * - reconcile advances `statusEventAt` to `retrieveSubscription().observedAt`, the
 *   provider server clock at which the state was observed (its API response Date).
 *
 * Ordering policy: reconcile advances the fence with a STRICT `<` guard evaluated
 * against the live row, so provider ordering (not commit timing) governs, and on an
 * equal provider-second timestamp the real webhook event wins. If the provider gives
 * no observation timestamp, reconcile fails closed and skips the fence write (never
 * substitutes local time). Drives real production functions against real PostgreSQL.
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
const DELAYED = new Date("2026-01-10T00:00:00.000Z"); // stale webhook (T0 < DELAYED < OBSERVED)
const OBSERVED = new Date("2026-01-20T00:00:00.000Z"); // provider observation time
const LATE = new Date("2026-03-01T00:00:00.000Z"); // a fence already newer than OBSERVED
const FUTURE = new Date("2999-01-01T00:00:00.000Z"); // a genuinely newer event (after OBSERVED)
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
    providerMocks.retrieveSubscription.mockResolvedValue({
      status: "active",
      providerSubscriptionRef: "sub_123",
      providerCustomerRef: "cus_123",
      currentPeriodEndsAt: PERIOD_END,
      cancelAtPeriodEnd: false,
      observedAt: OBSERVED,
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

  it("advances statusEventAt to the provider observation timestamp", async () => {
    const seeded = await seedSubscription();

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.statusEventAt).toEqual(OBSERVED);
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

  it("still applies a genuinely newer webhook created after the observation", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();

    await dispatchEvent(canceledEvent(FUTURE));

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("canceled");
    expect(row!.statusEventAt).toEqual(FUTURE);
  });

  it("lets a webhook at the exact observation second win (tie favors the real event)", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions(); // sets statusEventAt = OBSERVED

    await dispatchEvent(canceledEvent(OBSERVED));

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    // Webhook gate is `statusEventAt <= providerCreatedAt`, so an equal-second event applies.
    expect(row!.status).toBe("canceled");
    expect(row!.statusEventAt).toEqual(OBSERVED);
  });

  it("in-flight NEWER webhook (providerCreatedAt > observedAt) survives the reconcile write", async () => {
    const seeded = await seedSubscription();
    // A webhook newer than the observation commits during the provider call.
    providerMocks.retrieveSubscription.mockImplementation(async () => {
      await dispatchEvent(canceledEvent(FUTURE));
      return {
        status: "active",
        providerSubscriptionRef: "sub_123",
        providerCustomerRef: "cus_123",
        currentPeriodEndsAt: PERIOD_END,
        cancelAtPeriodEnd: false,
        observedAt: OBSERVED,
      };
    });

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    // statusEventAt (FUTURE) is not strictly below observedAt, so reconcile skips.
    expect(row!.status).toBe("canceled");
    expect(row!.statusEventAt).toEqual(FUTURE);
  });

  it("in-flight OLDER webhook loses to the fresher observation (provider ordering, not commit timing)", async () => {
    const seeded = await seedSubscription();
    // A webhook older than the observation commits during the provider call. Because
    // the observation already reflects it, reconcile (strictly newer) still wins.
    providerMocks.retrieveSubscription.mockImplementation(async () => {
      await dispatchEvent(canceledEvent(DELAYED));
      return {
        status: "active",
        providerSubscriptionRef: "sub_123",
        providerCustomerRef: "cus_123",
        currentPeriodEndsAt: PERIOD_END,
        cancelAtPeriodEnd: false,
        observedAt: OBSERVED,
      };
    });

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.statusEventAt).toEqual(OBSERVED);
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
    // No local-time substitution: status and fence are left untouched.
    expect(row!.status).toBe("past_due");
    expect(row!.statusEventAt).toEqual(T0);
  });

  it("does not let an older reconciled paid invoice regress a newer status fence (renewed ordering)", async () => {
    // Fence is already LATE (newer than the observation), so neither the status
    // write nor the paid-invoice apply may regress it.
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
