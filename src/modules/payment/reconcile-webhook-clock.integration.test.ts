import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #102 — deterministic reproduction of reconcile / webhook clock ordering.
 *
 * Hypothesis: `reconcileSubscriptions()` writes the latest remote status but does
 * NOT advance `statusEventAt`, while every webhook path only accepts an event when
 * `statusEventAt IS NULL OR statusEventAt <= providerCreatedAt`. A webhook that was
 * delayed in flight — carrying a semantically older status but a `providerCreatedAt`
 * that is still newer than the stale `statusEventAt` — can therefore overwrite the
 * fresher state that reconcile just pulled from the provider.
 *
 * These tests drive the real production functions (`reconcileSubscriptions`,
 * `persistPaymentProviderEvent`, `dispatchPaymentProviderEvent`) against real
 * PostgreSQL. They assert the CURRENT (buggy) behavior so the file is a living
 * record; each `BUG:` comment marks where the observed state is user-visibly wrong.
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

// Fixed points on the provider clock.
const T0 = new Date("2026-01-01T00:00:00.000Z"); // stale statusEventAt on the seeded row
const T1 = new Date("2026-01-10T00:00:00.000Z"); // a delayed webhook's providerCreatedAt (T0 < T1)
const PERIOD_END = new Date("2026-02-01T00:00:00.000Z"); // remote "active" period pulled by reconcile

describeWithDatabase("issue #102 reconcile / webhook clock ordering", () => {
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
    // Remote truth: the subscription is currently ACTIVE with a future period end.
    providerMocks.retrieveSubscription.mockResolvedValue({
      status: "active",
      providerSubscriptionRef: "sub_123",
      providerCustomerRef: "cus_123",
      currentPeriodEndsAt: PERIOD_END,
      cancelAtPeriodEnd: false,
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

  async function dispatchDelayedEvent(
    event: Record<string, unknown> & { providerEventId: string },
  ): Promise<void> {
    await persistPaymentProviderEvent("stripe", event as never);
    const [row] = await db
      .select({ id: paymentProviderEvents.id })
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, event.providerEventId));
    await dispatchPaymentProviderEvent(row!.id);
  }

  it("reconcile writes the latest remote status but does not advance statusEventAt", async () => {
    const seeded = await seedSubscription();
    expect(seeded.status).toBe("past_due");
    expect(seeded.statusEventAt).toEqual(T0);

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    // Reconcile pulled the fresher remote truth (active + future period).
    expect(row!.status).toBe("active");
    expect(row!.currentPeriodEndsAt).toEqual(PERIOD_END);
    // BUG: statusEventAt is left at the stale T0 instead of being advanced to the
    // reconcile time, leaving the gate open to any webhook with providerCreatedAt > T0.
    expect(row!.statusEventAt).toEqual(T0);
  });

  it("lets a delayed payment_failed webhook overwrite the reconciled active state", async () => {
    const seeded = await seedSubscription();

    // T-reconcile: pull remote truth -> local becomes active, statusEventAt stays T0.
    await reconcileSubscriptions();
    const [afterReconcile] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, seeded.id));
    expect(afterReconcile!.status).toBe("active");

    // A payment_failed webhook created at T1 (T0 < T1 < reconcile time) was delayed in
    // flight; its underlying transient failure has already been resolved at the provider.
    await dispatchDelayedEvent({
      type: "subscription_payment_failed",
      localSubscriptionId: seeded.id,
      providerSubscriptionRef: "sub_123",
      providerInvoiceRef: null,
      providerEventId: `evt_failed_${randomUUID()}`,
      providerCreatedAt: T1,
    });

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    // BUG (user-visible): local status is now past_due even though the provider's current
    // truth is active. An entitled member loses access based on a stale, delayed event.
    expect(row!.status).toBe("past_due");
    expect(row!.statusEventAt).toEqual(T1);
    // Consistency violation: status=past_due but the current period still points at the
    // active future period reconcile wrote, so the local row is internally inconsistent.
    expect(row!.currentPeriodEndsAt).toEqual(PERIOD_END);
  });

  it("lets a delayed canceled webhook overwrite the reconciled active state", async () => {
    const seeded = await seedSubscription();

    await reconcileSubscriptions();

    await dispatchDelayedEvent({
      type: "subscription_canceled",
      localSubscriptionId: seeded.id,
      providerSubscriptionRef: "sub_123",
      canceledAt: T1,
      providerEventId: `evt_canceled_${randomUUID()}`,
      providerCreatedAt: T1,
    });

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    // BUG (user-visible): local status is canceled while the provider truth is active.
    expect(row!.status).toBe("canceled");
    expect(row!.statusEventAt).toEqual(T1);
  });

  it("CONTROL: advancing statusEventAt to the reconcile time closes the gate", async () => {
    const seeded = await seedSubscription();

    await reconcileSubscriptions();
    // Simulate the candidate fix: reconcile advances statusEventAt to its own event time.
    const reconcileAt = new Date("2026-01-20T00:00:00.000Z"); // > T1
    await db
      .update(subscriptions)
      .set({ statusEventAt: reconcileAt })
      .where(eq(subscriptions.id, seeded.id));

    await dispatchDelayedEvent({
      type: "subscription_payment_failed",
      localSubscriptionId: seeded.id,
      providerSubscriptionRef: "sub_123",
      providerInvoiceRef: null,
      providerEventId: `evt_failed_${randomUUID()}`,
      providerCreatedAt: T1,
    });

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    // With statusEventAt advanced past the delayed event, the gate rejects the stale
    // webhook and the reconciled active state survives. This isolates the root cause.
    expect(row!.status).toBe("active");
    expect(row!.statusEventAt).toEqual(reconcileAt);
  });
});
