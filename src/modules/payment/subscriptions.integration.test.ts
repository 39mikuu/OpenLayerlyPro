import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  createSubscriptionCheckout: vi.fn(),
  getSubscriptionCheckoutState: vi.fn(),
  cancelSubscription: vi.fn(),
  retrieveSubscription: vi.fn(),
  listPaidSubscriptionInvoices: vi.fn(),
  resolveInvoiceByPaymentIntent: vi.fn(),
  resolveCheckoutByPaymentIntent: vi.fn(),
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
import { dispatchClaimedTask } from "@/modules/tasks/dispatcher";

import {
  applyPaidInvoice,
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
      resolveCheckoutByPaymentIntent: providerMocks.resolveCheckoutByPaymentIntent,
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
    providerMocks.resolveCheckoutByPaymentIntent.mockResolvedValue(null);
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

  it("keeps a resolver-found basil refund tombstone from granting a later paid invoice", async () => {
    const { user, subscription } = await seedSubscription();
    const event = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_refund_first_basil",
      providerPaymentRef: "pi_refund_first_basil",
    });
    providerMocks.resolveInvoiceByPaymentIntent.mockResolvedValue({
      providerInvoiceRef: event.providerInvoiceRef,
      providerSubscriptionRef: subscription.providerSubscriptionRef,
      localSubscriptionId: subscription.id,
    });

    await persistPaymentProviderEvent("stripe", {
      type: "refunded",
      paymentRef: event.providerPaymentRef!,
      providerEventId: "evt_refund_first_basil",
      providerCreatedAt: new Date("2026-01-31T23:59:00.000Z"),
    });
    const [refundRow] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_refund_first_basil"));
    await dispatchPaymentProviderEvent(refundRow!.id);
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", event));

    expect(providerMocks.resolveInvoiceByPaymentIntent).toHaveBeenCalledWith(
      event.providerPaymentRef,
    );
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(0);
    const [request] = await db.select().from(paymentRequests);
    expect(request).toMatchObject({
      status: "reversed",
      providerInvoiceRef: event.providerInvoiceRef,
      subscriptionId: subscription.id,
      reversalEventId: "evt_refund_first_basil",
    });
  });

  it("creates a resolver-found tombstone by provider subscription ref when invoice metadata is missing", async () => {
    const { user, subscription } = await seedSubscription();
    const event = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_refund_first_provider_ref",
      providerPaymentRef: "pi_refund_first_provider_ref",
    });
    providerMocks.resolveInvoiceByPaymentIntent.mockResolvedValue({
      providerInvoiceRef: event.providerInvoiceRef,
      providerSubscriptionRef: subscription.providerSubscriptionRef,
      localSubscriptionId: undefined,
    });

    await persistPaymentProviderEvent("stripe", {
      type: "refunded",
      paymentRef: event.providerPaymentRef!,
      providerEventId: "evt_refund_first_provider_ref",
      providerCreatedAt: new Date("2026-01-31T23:59:00.000Z"),
    });
    const [refundRow] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_refund_first_provider_ref"));
    await dispatchPaymentProviderEvent(refundRow!.id);
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", event));

    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(0);
    const [request] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.providerInvoiceRef, event.providerInvoiceRef));
    expect(request).toMatchObject({
      status: "reversed",
      providerInvoiceRef: event.providerInvoiceRef,
      subscriptionId: subscription.id,
      reversalEventId: "evt_refund_first_provider_ref",
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

  it("dead-letters final-attempt provider events and their durable dispatch task", async () => {
    const [eventRow] = await db
      .insert(paymentProviderEvents)
      .values({
        provider: "stripe",
        providerEventId: "evt_final_attempt_dead",
        eventType: "ignored",
        providerCreatedAt: new Date("2026-02-01T00:00:00.000Z"),
        payloadJson: {
          type: "ignored",
          providerEventId: "evt_final_attempt_dead",
          providerCreatedAt: "2026-02-01T00:00:00.000Z",
        },
        status: "processing",
        attempts: 5,
        maxAttempts: 5,
        lockedBy: "crashed-provider-worker",
        leaseUntil: new Date(Date.now() - 60_000),
      })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({
        kind: "payment_provider_event.dispatch",
        payloadJson: { eventRowId: eventRow!.id },
        status: "processing",
        attempts: 1,
        lockedBy: "task-worker",
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .returning();

    await dispatchClaimedTask(task!);

    const [storedEvent] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.id, eventRow!.id));
    const [storedTask] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(storedEvent).toMatchObject({
      status: "dead",
      lockedBy: null,
      error: "Payment provider event lease expired after the final execution attempt",
    });
    expect(storedTask).toMatchObject({
      status: "dead",
      lockedBy: null,
      lastError: "Payment provider event lease expired after the final execution attempt",
    });
  });

  it("rolls back paid invoice business changes when provider-event fencing fails", async () => {
    const { user, subscription } = await seedSubscription();
    const event = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_stale_worker",
      providerPaymentRef: "pi_stale_worker",
      providerEventId: "evt_stale_worker",
    });
    await persistPaymentProviderEvent("stripe", event);
    const [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, event.providerEventId));
    await db.execute(
      sql.raw(`
        create function steal_provider_event_lock_on_invoice_insert() returns trigger as $$
        begin
          if new.provider_invoice_ref = 'in_stale_worker' then
            update payment_provider_events
            set locked_by = 'worker-b'
            where id = '${row!.id}';
          end if;
          return new;
        end;
        $$ language plpgsql;
        create trigger steal_provider_event_lock_on_invoice_insert_trigger
        after insert on payment_requests
        for each row execute function steal_provider_event_lock_on_invoice_insert();
      `),
    );
    try {
      await expect(dispatchPaymentProviderEvent(row!.id)).rejects.toThrow(
        "Payment provider event fencing failed",
      );
    } finally {
      await db.execute(
        sql.raw(`
          drop trigger if exists steal_provider_event_lock_on_invoice_insert_trigger on payment_requests;
          drop function if exists steal_provider_event_lock_on_invoice_insert();
        `),
      );
    }

    const [eventAfterStaleCommit] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.id, row!.id));
    const requests = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.providerInvoiceRef, event.providerInvoiceRef));
    const grants = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    expect(eventAfterStaleCommit).toMatchObject({ status: "failed", lockedBy: null });
    expect(requests).toHaveLength(0);
    expect(grants).toHaveLength(0);
  });

  it("rolls back subscription reversal when the fenced commit fails", async () => {
    const { user, subscription } = await seedSubscription();
    const paid = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_reversal_rollback",
      providerPaymentRef: "pi_reversal_rollback",
    });
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", paid));
    providerMocks.resolveInvoiceByPaymentIntent.mockResolvedValue({
      providerInvoiceRef: paid.providerInvoiceRef,
      providerSubscriptionRef: subscription.providerSubscriptionRef,
      localSubscriptionId: subscription.id,
    });
    await persistPaymentProviderEvent("stripe", {
      type: "refunded",
      paymentRef: paid.providerPaymentRef!,
      providerEventId: "evt_reversal_rollback",
      providerCreatedAt: new Date("2026-02-02T00:00:00.000Z"),
    });
    const [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_reversal_rollback"));
    await db.execute(
      sql.raw(`
        create function steal_provider_event_lock_on_reversal_update() returns trigger as $$
        begin
          if new.reversal_event_id = 'evt_reversal_rollback' then
            update payment_provider_events
            set locked_by = 'worker-b'
            where id = '${row!.id}';
          end if;
          return new;
        end;
        $$ language plpgsql;
        create trigger steal_provider_event_lock_on_reversal_update_trigger
        after update on payment_requests
        for each row execute function steal_provider_event_lock_on_reversal_update();
      `),
    );
    try {
      await expect(dispatchPaymentProviderEvent(row!.id)).rejects.toThrow(
        "Payment provider event fencing failed",
      );
    } finally {
      await db.execute(
        sql.raw(`
          drop trigger if exists steal_provider_event_lock_on_reversal_update_trigger on payment_requests;
          drop function if exists steal_provider_event_lock_on_reversal_update();
        `),
      );
    }

    const [request] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.providerInvoiceRef, paid.providerInvoiceRef));
    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    const [eventRow] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.id, row!.id));
    expect(request).toMatchObject({ status: "approved", reversalEventId: null });
    expect(membership).toMatchObject({ status: "active" });
    expect(eventRow).toMatchObject({ status: "failed", lockedBy: null });
  });

  it("rolls back legacy one-time paid work when the fenced commit fails", async () => {
    const { user, tier } = await seed();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "cs_paid_rollback",
        amountMinor: 900,
        currency: "usd",
        amountLabel: "$9",
        durationDays: 31,
      })
      .returning();
    await persistPaymentProviderEvent("stripe", {
      type: "paid",
      providerRef: "cs_paid_rollback",
      paymentRef: "pi_paid_rollback",
      requestId: request!.id,
      providerEventId: "evt_paid_rollback",
      amountMinor: 900,
      currency: "usd",
    });
    const [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_paid_rollback"));
    await db.execute(
      sql.raw(`
        create function steal_provider_event_lock_on_paid_update() returns trigger as $$
        begin
          if new.provider_event_id = 'evt_paid_rollback' then
            update payment_provider_events
            set locked_by = 'worker-b'
            where id = '${row!.id}';
          end if;
          return new;
        end;
        $$ language plpgsql;
        create trigger steal_provider_event_lock_on_paid_update_trigger
        after update on payment_requests
        for each row execute function steal_provider_event_lock_on_paid_update();
      `),
    );
    try {
      await expect(dispatchPaymentProviderEvent(row!.id)).rejects.toThrow(
        "Payment provider event fencing failed",
      );
    } finally {
      await db.execute(
        sql.raw(`
          drop trigger if exists steal_provider_event_lock_on_paid_update_trigger on payment_requests;
          drop function if exists steal_provider_event_lock_on_paid_update();
        `),
      );
    }

    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request!.id));
    const [eventRow] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.id, row!.id));
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(0);
    expect(stored).toMatchObject({
      status: "pending_payment",
      providerEventId: null,
      providerPaymentRef: null,
      grantedMembershipId: null,
    });
    expect(eventRow).toMatchObject({ status: "failed", lockedBy: null });
  });

  it("keeps resolution failures retryable with no business commit", async () => {
    const { user, subscription } = await seedSubscription();
    await persistPaymentProviderEvent("stripe", {
      type: "refunded",
      paymentRef: "pi_resolution_failure",
      providerEventId: "evt_resolution_failure",
      providerCreatedAt: new Date("2026-02-02T00:00:00.000Z"),
    });
    const [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_resolution_failure"));
    providerMocks.resolveInvoiceByPaymentIntent.mockRejectedValue(new Error("stripe unavailable"));

    await expect(dispatchPaymentProviderEvent(row!.id)).rejects.toThrow("stripe unavailable");

    const [eventRow] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.id, row!.id));
    expect(eventRow).toMatchObject({ status: "failed", attempts: 1, lockedBy: null });
    await expect(db.select().from(paymentRequests)).resolves.toHaveLength(0);
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)),
    ).resolves.toHaveLength(1);
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
      observedAt: new Date(),
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
      observedAt: new Date(),
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
      observedAt: new Date(),
    });
    providerMocks.listPaidSubscriptionInvoices.mockResolvedValue([event]);

    await expect(reconcileSubscriptions()).resolves.toBe(1);
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(1);
  });

  it("resolves a subscription dispute without invoiceRef and revokes the paid period", async () => {
    const { user, subscription } = await seedSubscription();
    const paid = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_dispute_resolved",
      providerPaymentRef: "pi_dispute_resolved",
    });
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", paid));
    providerMocks.resolveInvoiceByPaymentIntent.mockResolvedValue({
      providerInvoiceRef: paid.providerInvoiceRef,
      providerSubscriptionRef: subscription.providerSubscriptionRef,
      localSubscriptionId: subscription.id,
    });
    await persistPaymentProviderEvent("stripe", {
      type: "disputed",
      paymentRef: paid.providerPaymentRef!,
      providerEventId: "evt_dispute_without_invoice",
      providerCreatedAt: new Date("2026-02-02T00:00:00.000Z"),
    });
    const [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_dispute_without_invoice"));

    await dispatchPaymentProviderEvent(row!.id);

    expect(providerMocks.resolveInvoiceByPaymentIntent).toHaveBeenCalledWith(
      paid.providerPaymentRef,
    );
    const [request] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.providerInvoiceRef, paid.providerInvoiceRef));
    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    expect(request?.status).toBe("reversed");
    expect(membership?.status).toBe("revoked");
  });

  it("falls back to one-time reversal when a refund cannot resolve an invoice", async () => {
    const { user, tier } = await seed();
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: user.id,
        tierId: tier.id,
        flow: "auto",
        status: "pending_payment",
        provider: "stripe",
        providerRef: "cs_one_time_refund",
        amountMinor: 900,
        currency: "usd",
        amountLabel: "$9",
        durationDays: 31,
      })
      .returning();
    const oneTimePaid = {
      type: "paid" as const,
      providerRef: "cs_one_time_refund",
      paymentRef: "pi_one_time_refund",
      requestId: request!.id,
      providerEventId: "evt_one_time_paid",
      amountMinor: 900,
      currency: "usd",
    };
    await persistPaymentProviderEvent("stripe", oneTimePaid);
    await persistPaymentProviderEvent("stripe", oneTimePaid);
    let [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_one_time_paid"));
    await Promise.all([
      dispatchPaymentProviderEvent(row!.id),
      dispatchPaymentProviderEvent(row!.id),
    ]);
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(1);

    providerMocks.resolveInvoiceByPaymentIntent.mockResolvedValue(null);
    await persistPaymentProviderEvent("stripe", {
      type: "refunded",
      paymentRef: "pi_one_time_refund",
      providerEventId: "evt_one_time_refund",
    });
    [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_one_time_refund"));
    await dispatchPaymentProviderEvent(row!.id);

    expect(providerMocks.resolveInvoiceByPaymentIntent).toHaveBeenCalledWith("pi_one_time_refund");
    const [stored] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request!.id));
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, stored!.grantedMembershipId!));
    expect(stored?.status).toBe("reversed");
    expect(membership?.status).toBe("revoked");
  });

  it("keeps paid entitlement when invoice.paid arrives before subscription.created", async () => {
    const { user, subscription } = await seedSubscription();
    const paid = paidInvoiceEvent({ localSubscriptionId: subscription.id });
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", paid));
    await persistPaymentProviderEvent("stripe", {
      type: "subscription_activated",
      localSubscriptionId: subscription.id,
      providerSubscriptionRef: subscription.providerSubscriptionRef!,
      providerCustomerRef: "cus_late_created",
      currentPeriodEndsAt: paid.lines[0]!.periodEnd,
      cancelAtPeriodEnd: false,
      providerEventId: "evt_late_subscription_created",
      providerCreatedAt: new Date("2026-02-01T00:00:20.000Z"),
    });
    const [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_late_subscription_created"));
    await dispatchPaymentProviderEvent(row!.id);

    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(1);
  });

  it("grants a paid invoice even when subscription.deleted arrived first", async () => {
    const { user, subscription } = await seedSubscription();
    await persistPaymentProviderEvent("stripe", {
      type: "subscription_canceled",
      providerSubscriptionRef: subscription.providerSubscriptionRef!,
      canceledAt: new Date("2026-01-31T23:59:00.000Z"),
      providerEventId: "evt_canceled_before_paid",
      providerCreatedAt: new Date("2026-01-31T23:59:00.000Z"),
    });
    const [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_canceled_before_paid"));
    await dispatchPaymentProviderEvent(row!.id);

    const paid = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_after_canceled",
      providerCreatedAt: new Date("2026-02-01T00:00:10.000Z"),
    });
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", paid));

    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(1);
  });

  it("does not let an old failed event replay roll back a later paid invoice", async () => {
    const { user, subscription } = await seedSubscription();
    const failedAt = new Date("2026-02-01T00:00:00.000Z");
    await persistPaymentProviderEvent("stripe", {
      type: "subscription_payment_failed",
      localSubscriptionId: subscription.id,
      providerSubscriptionRef: subscription.providerSubscriptionRef!,
      providerInvoiceRef: "in_failed_then_paid",
      providerEventId: "evt_failed_first",
      providerCreatedAt: failedAt,
    });
    let [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_failed_first"));
    await dispatchPaymentProviderEvent(row!.id);

    const paid = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_failed_then_paid",
      providerCreatedAt: new Date("2026-02-01T00:01:00.000Z"),
    });
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", paid));

    await persistPaymentProviderEvent("stripe", {
      type: "subscription_payment_failed",
      localSubscriptionId: subscription.id,
      providerSubscriptionRef: subscription.providerSubscriptionRef!,
      providerInvoiceRef: "in_failed_then_paid",
      providerEventId: "evt_failed_replay",
      providerCreatedAt: failedAt,
    });
    [row] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerEventId, "evt_failed_replay"));
    await dispatchPaymentProviderEvent(row!.id);

    const [stored] = await db.select().from(subscriptions);
    expect(stored?.status).toBe("active");
    await expect(
      db.select().from(memberships).where(eq(memberships.userId, user.id)),
    ).resolves.toHaveLength(1);
  });

  it("grants back-to-back renewal periods with no overlap or gap", async () => {
    const { user, subscription } = await seedSubscription();
    const first = paidInvoiceEvent({ localSubscriptionId: subscription.id });
    const second = paidInvoiceEvent({
      localSubscriptionId: subscription.id,
      providerInvoiceRef: "in_renewal_second",
      providerPaymentRef: "pi_renewal_second",
      providerEventId: "evt_renewal_second",
      providerCreatedAt: new Date("2026-03-01T00:00:10.000Z"),
      lines: [
        {
          providerPriceRef: "price_monthly_snapshot",
          periodStart: first.lines[0]!.periodEnd,
          periodEnd: new Date("2026-04-01T00:00:00.000Z"),
          amountMinor: 900,
        },
      ],
    });
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", first));
    await db.transaction((tx) => applyPaidInvoice(tx, "stripe", second));

    const rows = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    expect(rows).toHaveLength(2);
    expect(rows[0]!.endsAt).toEqual(rows[1]!.startsAt);
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
