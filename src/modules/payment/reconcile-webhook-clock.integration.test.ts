import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #112 — regression guard for the reconcile / webhook clock ordering fix
 * (defect reproduced under #102).
 *
 * Clock model (single domain — provider/Stripe server time):
 * - webhook ordering uses `providerCreatedAt` (provider event time);
 * - reconcile advances `statusEventAt` to `retrieveSubscription().observedAt`, the
 *   provider server clock at which the state was observed (its API response Date).
 * A webhook created at or before the observation is already reflected and stale.
 *
 * Races covered:
 * - a delayed older webhook after reconcile is rejected;
 * - a genuinely newer webhook (after the observation) is still accepted;
 * - a webhook committing while retrieveSubscription() is in flight is NOT
 *   overwritten by reconcile — the `version` CAS makes the reconcile write a no-op.
 *
 * Drives the real production functions against real PostgreSQL. No provider I/O.
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
const DELAYED = new Date("2026-01-10T00:00:00.000Z"); // stale in-flight webhook (T0 < DELAYED < OBSERVED)
const OBSERVED = new Date("2026-01-20T00:00:00.000Z"); // provider observation time from retrieveSubscription
const FUTURE = new Date("2999-01-01T00:00:00.000Z"); // a genuinely newer event (after OBSERVED)
const PERIOD_END = new Date("2026-02-01T00:00:00.000Z");

describeWithDatabase(
  "issue #112 reconcile advances statusEventAt in the provider clock domain",
  () => {
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

    it("CAS: a webhook committing while retrieveSubscription() is in flight is not overwritten", async () => {
      const seeded = await seedSubscription();

      // Simulate a webhook that commits during the provider call. It cancels the
      // subscription (providerCreatedAt DELAYED > seeded T0, so it passes the fence)
      // and bumps `version`. reconcile then observes "active" at OBSERVED, but its
      // version CAS no longer matches, so the reconcile write is skipped.
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
      // The concurrent webhook's canceled state survives; reconcile did not clobber it.
      expect(row!.status).toBe("canceled");
      expect(row!.statusEventAt).toEqual(DELAYED);
    });
  },
);
