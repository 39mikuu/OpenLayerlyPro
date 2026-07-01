import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #112 — regression guard for the reconcile / webhook clock ordering fix
 * (defect reproduced under #102).
 *
 * reconcileSubscriptions() now advances statusEventAt to the observation time under
 * the same monotonic guard the webhooks use, so a stale delayed webhook can no
 * longer overwrite the reconciled state, while a genuinely newer webhook still wins.
 * Drives the real production functions against real PostgreSQL.
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
const DELAYED = new Date("2026-01-10T00:00:00.000Z"); // a stale in-flight webhook (T0 < DELAYED < reconcile)
const PERIOD_END = new Date("2026-02-01T00:00:00.000Z");
const FUTURE = new Date("2999-01-01T00:00:00.000Z"); // a genuinely newer event (after reconcile)

describeWithDatabase("issue #112 reconcile advances statusEventAt", () => {
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
    });
    providerMocks.listPaidSubscriptionInvoices.mockResolvedValue([]);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seedSubscription() {
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

  it("advances statusEventAt to roughly the reconcile observation time", async () => {
    const seeded = await seedSubscription();
    const before = new Date();

    await reconcileSubscriptions();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
    expect(row!.statusEventAt).not.toBeNull();
    // Advanced far past the stale T0, to around "now".
    expect(row!.statusEventAt!.getTime()).toBeGreaterThan(T0.getTime());
    expect(row!.statusEventAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it("rejects a delayed payment_failed webhook after reconcile", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();

    await dispatchEvent({
      type: "subscription_payment_failed",
      localSubscriptionId: seeded.id,
      providerSubscriptionRef: "sub_123",
      providerInvoiceRef: null,
      providerEventId: `evt_failed_${randomUUID()}`,
      providerCreatedAt: DELAYED,
    });

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    // The stale event is gated out; the reconciled active state and its period survive.
    expect(row!.status).toBe("active");
    expect(row!.currentPeriodEndsAt).toEqual(PERIOD_END);
  });

  it("rejects a delayed canceled webhook after reconcile", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();

    await dispatchEvent({
      type: "subscription_canceled",
      localSubscriptionId: seeded.id,
      providerSubscriptionRef: "sub_123",
      canceledAt: DELAYED,
      providerEventId: `evt_canceled_${randomUUID()}`,
      providerCreatedAt: DELAYED,
    });

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    expect(row!.status).toBe("active");
  });

  it("still applies a genuinely newer webhook after reconcile (guard is monotonic, not a blanket block)", async () => {
    const seeded = await seedSubscription();
    await reconcileSubscriptions();

    await dispatchEvent({
      type: "subscription_canceled",
      localSubscriptionId: seeded.id,
      providerSubscriptionRef: "sub_123",
      canceledAt: FUTURE,
      providerEventId: `evt_canceled_${randomUUID()}`,
      providerCreatedAt: FUTURE,
    });

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, seeded.id));
    // An event newer than the reconcile observation still wins.
    expect(row!.status).toBe("canceled");
    expect(row!.statusEventAt).toEqual(FUTURE);
  });
});
