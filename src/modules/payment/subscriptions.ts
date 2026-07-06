import { randomUUID } from "crypto";
import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";

import { getDb, type TxClient } from "@/db";
import {
  memberships,
  membershipTiers,
  type PaymentProviderEvent,
  paymentProviderEvents,
  type PaymentRequest,
  paymentRequests,
  type Subscription,
  subscriptions,
  users,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { recordAudit } from "@/modules/audit";
import { grantMembershipForPeriod, revokeMembership } from "@/modules/membership";
import { enqueueTask, PermanentTaskError } from "@/modules/tasks";

import { confirmAutoPayment, expireAutoPayment, reverseAutoPayment } from ".";
import {
  getPaymentProvider,
  type NormalizedPaymentEvent,
  type ReversalPaymentEvent,
  type SubscriptionCanceledPaymentEvent,
  type SubscriptionPaymentFailedEvent,
  type SubscriptionRenewedPaymentEvent,
} from "./providers";

const SUBSCRIPTION_CHECKOUT_CLAIM_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_EVENT_LEASE_MS = 60_000;
const PROVIDER_EVENT_ERROR_MAX_LENGTH = 2_000;
const RECENT_TERMINAL_RECONCILE_DAYS = 90;

type SubscriptionCheckoutInput = {
  userId: string;
  tierId: string;
  successUrl: string;
  cancelUrl: string;
};

type ResolvedCheckoutByPaymentIntent = Awaited<
  ReturnType<
    NonNullable<Awaited<ReturnType<typeof getPaymentProvider>>>["resolveCheckoutByPaymentIntent"]
  >
>;

type ResolvedProviderEvent =
  | { event: Exclude<NormalizedPaymentEvent, ReversalPaymentEvent>; oneTimeCheckout: null }
  | {
      event: ReversalPaymentEvent & {
        providerInvoiceRef?: string;
        providerSubscriptionRef?: string | null;
        localSubscriptionId?: string;
      };
      oneTimeCheckout: ResolvedCheckoutByPaymentIntent;
    };

type ClaimProviderEventResult =
  | { kind: "claimed"; event: PaymentProviderEvent }
  | { kind: "already-processed" }
  | { kind: "dead"; reason: string };

export async function getCurrentStripeSubscription(userId: string): Promise<{
  subscription: Subscription;
  tier: { name: string };
} | null> {
  const [row] = await getDb()
    .select({ subscription: subscriptions, tier: { name: membershipTiers.name } })
    .from(subscriptions)
    .innerJoin(membershipTiers, eq(membershipTiers.id, subscriptions.tierId))
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.provider, "stripe"),
        inArray(subscriptions.status, ["pending", "active", "past_due"]),
      ),
    )
    .orderBy(sql`${subscriptions.updatedAt} desc`)
    .limit(1);
  return row ?? null;
}

function eventProviderCreatedAt(event: NormalizedPaymentEvent): Date {
  return event.providerCreatedAt ?? new Date();
}

function providerEventObjectRef(event: NormalizedPaymentEvent): string | null {
  if (event.type === "paid" || event.type === "expired") return event.providerRef;
  if (event.type === "refunded" || event.type === "disputed") {
    return event.providerInvoiceRef ?? event.paymentRef;
  }
  if (event.type === "subscription_renewed") return event.providerInvoiceRef;
  if (event.type === "subscription_payment_failed") {
    return event.providerInvoiceRef ?? event.providerSubscriptionRef;
  }
  if (event.type === "subscription_activated" || event.type === "subscription_canceled") {
    return event.providerSubscriptionRef;
  }
  return null;
}

function revivePaymentEvent(payload: unknown): NormalizedPaymentEvent {
  const raw = payload as NormalizedPaymentEvent;
  const event = { ...raw } as NormalizedPaymentEvent;
  if ("providerCreatedAt" in event && event.providerCreatedAt) {
    event.providerCreatedAt = new Date(event.providerCreatedAt);
  }
  if (event.type === "subscription_renewed") {
    event.lines = event.lines.map((line) => ({
      ...line,
      periodStart: new Date(line.periodStart),
      periodEnd: new Date(line.periodEnd),
    }));
  }
  if (event.type === "subscription_activated" && event.currentPeriodEndsAt) {
    event.currentPeriodEndsAt = new Date(event.currentPeriodEndsAt);
  }
  if (event.type === "subscription_canceled" && event.canceledAt) {
    event.canceledAt = new Date(event.canceledAt);
  }
  return event;
}

async function enqueueProviderEventTask(tx: TxClient, eventRowId: string): Promise<void> {
  await enqueueTask(tx, {
    kind: "payment_provider_event.dispatch",
    dedupeKey: `payment-provider-event:${eventRowId}`,
    payload: { eventRowId },
  });
}

export async function enqueueSubscriptionReconcileTask(
  tx: TxClient,
  runAfter = new Date(),
): Promise<void> {
  await enqueueTask(tx, {
    kind: "subscription.reconcile",
    dedupeKey: "subscription.reconcile",
    payload: {},
    runAfter,
  });
}

export function nextSubscriptionReconcileAt(now = new Date()): Date {
  return new Date(now.getTime() + getEnv().SUBSCRIPTION_RECONCILE_INTERVAL_MINUTES * 60 * 1000);
}

export async function persistPaymentProviderEvent(
  provider: string,
  event: NormalizedPaymentEvent,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [inserted] = await tx
      .insert(paymentProviderEvents)
      .values({
        provider,
        providerEventId: event.providerEventId,
        eventType: event.type,
        objectRef: providerEventObjectRef(event),
        providerCreatedAt: eventProviderCreatedAt(event),
        payloadJson: event,
        status: "received",
      })
      .onConflictDoNothing({
        target: [paymentProviderEvents.provider, paymentProviderEvents.providerEventId],
      })
      .returning({ id: paymentProviderEvents.id });
    const eventRowId =
      inserted?.id ??
      (
        await tx
          .select({ id: paymentProviderEvents.id })
          .from(paymentProviderEvents)
          .where(
            and(
              eq(paymentProviderEvents.provider, provider),
              eq(paymentProviderEvents.providerEventId, event.providerEventId),
            ),
          )
          .limit(1)
      )[0]?.id;
    if (!eventRowId) throw new Error("Payment provider event conflict row missing");
    await enqueueProviderEventTask(tx, eventRowId);
    await enqueueSubscriptionReconcileTask(tx);
  });
}

async function claimProviderEvent(
  eventRowId: string,
  lockToken: string,
): Promise<ClaimProviderEventResult> {
  return getDb().transaction(async (tx) => {
    const finalAttemptReason =
      "Payment provider event lease expired after the final execution attempt";
    const [dead] = await tx
      .update(paymentProviderEvents)
      .set({
        status: "dead",
        lockedBy: null,
        leaseUntil: null,
        error: finalAttemptReason,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(paymentProviderEvents.id, eventRowId),
          eq(paymentProviderEvents.status, "processing"),
          sql`${paymentProviderEvents.leaseUntil} < now()`,
          sql`${paymentProviderEvents.attempts} >= ${paymentProviderEvents.maxAttempts}`,
        ),
      )
      .returning({ id: paymentProviderEvents.id });
    if (dead) return { kind: "dead", reason: finalAttemptReason };

    const [claimed] = await tx
      .update(paymentProviderEvents)
      .set({
        status: "processing",
        attempts: sql`${paymentProviderEvents.attempts} + 1`,
        lockedBy: lockToken,
        leaseUntil: sql`now() + (${PROVIDER_EVENT_LEASE_MS} * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(paymentProviderEvents.id, eventRowId),
          sql`${paymentProviderEvents.attempts} < ${paymentProviderEvents.maxAttempts}`,
          or(
            eq(paymentProviderEvents.status, "received"),
            eq(paymentProviderEvents.status, "failed"),
            and(
              eq(paymentProviderEvents.status, "processing"),
              sql`${paymentProviderEvents.leaseUntil} < now()`,
            ),
          ),
        ),
      )
      .returning();
    if (claimed) return { kind: "claimed", event: claimed };

    const [event] = await tx
      .select({
        status: paymentProviderEvents.status,
        error: paymentProviderEvents.error,
      })
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.id, eventRowId))
      .limit(1);
    if (event?.status === "dead") {
      return { kind: "dead", reason: event.error ?? "Payment provider event is dead" };
    }
    return { kind: "already-processed" };
  });
}

async function resolveProviderEvent(
  provider: string,
  event: NormalizedPaymentEvent,
): Promise<ResolvedProviderEvent> {
  if (event.type !== "refunded" && event.type !== "disputed") {
    return { event, oneTimeCheckout: null };
  }

  if (event.providerInvoiceRef) return { event: { ...event }, oneTimeCheckout: null };

  const providerClient = await getPaymentProvider(provider);
  const invoice = await providerClient?.resolveInvoiceByPaymentIntent?.(event.paymentRef);
  if (invoice?.providerInvoiceRef) {
    return {
      event: {
        ...event,
        providerInvoiceRef: invoice.providerInvoiceRef,
        ...(invoice.providerSubscriptionRef
          ? { providerSubscriptionRef: invoice.providerSubscriptionRef }
          : {}),
        ...(invoice.localSubscriptionId
          ? { localSubscriptionId: invoice.localSubscriptionId }
          : {}),
      },
      oneTimeCheckout: null,
    };
  }

  const checkout = await providerClient?.resolveCheckoutByPaymentIntent?.(event.paymentRef);
  return { event: { ...event }, oneTimeCheckout: checkout ?? null };
}

async function markProviderEventFailed(
  id: string,
  lockToken: string,
  error: unknown,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(paymentProviderEvents)
      .where(
        and(
          eq(paymentProviderEvents.id, id),
          eq(paymentProviderEvents.status, "processing"),
          eq(paymentProviderEvents.lockedBy, lockToken),
        ),
      )
      .limit(1)
      .for("update");
    if (!event) return;

    await tx
      .update(paymentProviderEvents)
      .set({
        status: event.attempts >= event.maxAttempts ? "dead" : "failed",
        lockedBy: null,
        leaseUntil: null,
        error: String(error).slice(0, PROVIDER_EVENT_ERROR_MAX_LENGTH),
        updatedAt: sql`now()`,
      })
      .where(eq(paymentProviderEvents.id, id));
  });
}

export async function dispatchPaymentProviderEvent(eventRowId: string): Promise<void> {
  const lockToken = randomUUID();
  const claim = await claimProviderEvent(eventRowId, lockToken);
  if (claim.kind === "already-processed") return;
  if (claim.kind === "dead") throw new PermanentTaskError(claim.reason);
  const claimed = claim.event;

  try {
    const resolved = await resolveProviderEvent(
      claimed.provider,
      revivePaymentEvent(claimed.payloadJson),
    );

    await getDb().transaction(async (tx) => {
      await applyProviderEventInTransaction(tx, claimed.provider, resolved);
      const [processed] = await tx
        .update(paymentProviderEvents)
        .set({
          status: "processed",
          processedAt: sql`now()`,
          lockedBy: null,
          leaseUntil: null,
          error: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(paymentProviderEvents.id, claimed.id),
            eq(paymentProviderEvents.status, "processing"),
            eq(paymentProviderEvents.lockedBy, lockToken),
          ),
        )
        .returning({ id: paymentProviderEvents.id });
      if (!processed) throw new Error("Payment provider event fencing failed");
    });
  } catch (error) {
    await markProviderEventFailed(claimed.id, lockToken, error);
    throw error;
  }
}

async function getSubscriptionForPaidInvoice(
  tx: TxClient,
  event: SubscriptionRenewedPaymentEvent,
): Promise<Subscription> {
  const conditions = [];
  if (event.localSubscriptionId) conditions.push(eq(subscriptions.id, event.localSubscriptionId));
  conditions.push(eq(subscriptions.providerSubscriptionRef, event.providerSubscriptionRef));

  const [subscription] = await tx
    .select()
    .from(subscriptions)
    .where(or(...conditions))
    .limit(1)
    .for("update");
  if (!subscription) throw new ApiError(503, "subscriptionUnresolved");
  return subscription;
}

async function updateSubscriptionFromPaidInvoice(
  tx: TxClient,
  subscription: Subscription,
  event: SubscriptionRenewedPaymentEvent,
  line: SubscriptionRenewedPaymentEvent["lines"][number],
): Promise<void> {
  const eventAt = event.providerCreatedAt;
  await tx
    .update(subscriptions)
    .set({
      status: "active",
      providerSubscriptionRef: event.providerSubscriptionRef,
      currentPeriodEndsAt: line.periodEnd,
      statusEventAt: eventAt,
      updatedAt: eventAt,
      version: sql`${subscriptions.version} + 1`,
    })
    .where(
      and(
        eq(subscriptions.id, subscription.id),
        or(sql`${subscriptions.statusEventAt} is null`, lte(subscriptions.statusEventAt, eventAt)),
      ),
    );
}

function selectInvoiceLineForSubscription(
  subscription: Subscription,
  event: SubscriptionRenewedPaymentEvent,
): SubscriptionRenewedPaymentEvent["lines"][number] {
  const expectedPriceRef = subscription.providerPriceRef;
  if (!expectedPriceRef) throw new ApiError(409, "subscriptionPriceMismatch");
  if (event.providerPriceRef && event.providerPriceRef !== expectedPriceRef) {
    throw new ApiError(409, "subscriptionPriceMismatch");
  }
  const matchingLines = event.lines.filter((line) => line.providerPriceRef === expectedPriceRef);
  if (matchingLines.length !== 1) throw new ApiError(422, "stripeInvoiceLineAmbiguous");
  return matchingLines[0]!;
}

export async function applyPaidInvoice(
  tx: TxClient,
  provider: string,
  event: SubscriptionRenewedPaymentEvent,
): Promise<PaymentRequest | null> {
  const subscription = await getSubscriptionForPaidInvoice(tx, event);
  const invoiceLine = selectInvoiceLineForSubscription(subscription, event);
  if (
    subscription.expectedAmountMinor !== invoiceLine.amountMinor ||
    subscription.expectedCurrency?.toLowerCase() !== event.currency.toLowerCase()
  ) {
    throw new ApiError(409, "paymentAmountMismatch");
  }

  const [created] = await tx
    .insert(paymentRequests)
    .values({
      userId: subscription.userId,
      tierId: subscription.tierId,
      status: "approved",
      flow: "auto",
      provider,
      providerRef: event.providerSubscriptionRef,
      providerEventId: event.providerEventId.startsWith("reconcile:")
        ? null
        : event.providerEventId,
      providerPaymentRef: event.providerPaymentRef,
      providerInvoiceRef: event.providerInvoiceRef,
      subscriptionId: subscription.id,
      amountMinor: invoiceLine.amountMinor,
      currency: event.currency.toLowerCase(),
      amountLabel: `${invoiceLine.amountMinor} ${event.currency.toUpperCase()}`,
      durationDays: 0,
      reviewedAt: event.providerCreatedAt,
    })
    .onConflictDoNothing({
      target: [paymentRequests.provider, paymentRequests.providerInvoiceRef],
      where: sql.raw("provider_invoice_ref is not null"),
    })
    .returning();

  if (!created) {
    const [existing] = await tx
      .select()
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.provider, provider),
          eq(paymentRequests.providerInvoiceRef, event.providerInvoiceRef),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Invoice conflict row missing");
    if (existing.status === "reversed") return null;
    return existing.status === "approved" ? existing : null;
  }

  const correlationId = randomUUID();
  const paymentAudit = await recordAudit(tx, {
    entityType: "payment_request",
    entityId: created.id,
    action: "subscription_invoice_paid",
    actor: { type: "system", id: null },
    after: {
      status: "approved",
      provider,
      providerInvoiceRef: event.providerInvoiceRef,
      providerEventId: event.providerEventId,
    },
    correlationId,
  });

  const granted = await grantMembershipForPeriod(
    {
      userId: subscription.userId,
      tierId: subscription.tierId,
      source: "payment_auto",
      startsAt: invoiceLine.periodStart,
      endsAt: invoiceLine.periodEnd,
      note: `Stripe invoice ${event.providerInvoiceRef}`,
      actor: { type: "system", id: null },
      correlationId,
      causationId: paymentAudit.id,
    },
    tx,
  );

  const [updated] = await tx
    .update(paymentRequests)
    .set({ grantedMembershipId: granted.membership.id, updatedAt: sql`now()` })
    .where(eq(paymentRequests.id, created.id))
    .returning();
  if (!updated) throw new Error("Failed to link subscription membership grant");

  await updateSubscriptionFromPaidInvoice(tx, subscription, event, invoiceLine);

  const [user] = await tx.select().from(users).where(eq(users.id, subscription.userId)).limit(1);
  if (!user) throw new Error("Subscription user not found");
  await enqueueTask(tx, {
    kind: "email",
    dedupeKey: `email:membership_activated:${created.id}`,
    payload: {
      template: "membership_activated",
      to: user.email,
      locale: user.locale,
      params: {
        tierName: granted.tier.name,
        endsAt: granted.membership.endsAt.toISOString(),
      },
    },
  });

  return updated;
}

async function applySubscriptionReversal(
  tx: TxClient,
  request: PaymentRequest,
  event: ReversalPaymentEvent,
  provider: string,
): Promise<void> {
  if (!request.grantedMembershipId) return;
  const correlationId = randomUUID();
  const action = event.type === "refunded" ? "payment_auto_refunded" : "payment_auto_disputed";
  const reverseEvent = await recordAudit(tx, {
    entityType: "payment_request",
    entityId: request.id,
    action,
    actor: { type: "system", id: null },
    reason: event.type === "refunded" ? "Stripe refund" : "Stripe dispute",
    before: { status: "approved" },
    after: {
      status: "reversed",
      provider,
      providerInvoiceRef: request.providerInvoiceRef,
      reversalEventId: event.providerEventId,
    },
    correlationId,
  });

  const [membership] = await tx
    .select()
    .from(memberships)
    .where(eq(memberships.id, request.grantedMembershipId))
    .limit(1)
    .for("update");
  if (!membership || membership.status === "revoked") return;

  await revokeMembership(
    membership.id,
    {
      reason: event.type === "refunded" ? "Stripe refund" : "Stripe dispute",
      actor: { type: "system", id: null },
      expectedVersion: membership.version,
      correlationId,
      causationId: reverseEvent.id,
    },
    tx,
  );
}

export async function applySubscriptionReversalOrTombstone(
  tx: TxClient,
  provider: string,
  event: ReversalPaymentEvent & {
    providerSubscriptionRef?: string | null;
    localSubscriptionId?: string;
  },
): Promise<void> {
  if (!event.providerInvoiceRef) throw new ApiError(503, "subscriptionReversalInvoiceUnresolved");

  const [existing] = await tx
    .select()
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.provider, provider),
        eq(paymentRequests.providerInvoiceRef, event.providerInvoiceRef),
      ),
    )
    .limit(1)
    .for("update");

  if (existing?.status === "approved") {
    const [reversed] = await tx
      .update(paymentRequests)
      .set({
        status: "reversed",
        reversalEventId: event.providerEventId,
        updatedAt: sql`now()`,
      })
      .where(and(eq(paymentRequests.id, existing.id), eq(paymentRequests.status, "approved")))
      .returning();
    if (reversed) await applySubscriptionReversal(tx, reversed, event, provider);
    return;
  }
  if (existing) return;

  const localSubscriptionId = event.localSubscriptionId;
  const providerSubscriptionRef = event.providerSubscriptionRef;
  const [subscriptionByLocalId] = localSubscriptionId
    ? await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, localSubscriptionId))
        .limit(1)
    : [];
  const [subscriptionByProviderRef] =
    !subscriptionByLocalId && providerSubscriptionRef
      ? await tx
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.provider, provider),
              eq(subscriptions.providerSubscriptionRef, providerSubscriptionRef),
            ),
          )
          .limit(1)
      : [];
  const subscription = subscriptionByLocalId ?? subscriptionByProviderRef;
  if (!subscription) throw new ApiError(503, "subscriptionUnresolved");

  await tx
    .insert(paymentRequests)
    .values({
      userId: subscription.userId,
      tierId: subscription.tierId,
      status: "reversed",
      flow: "auto",
      provider,
      providerPaymentRef: event.paymentRef,
      providerInvoiceRef: event.providerInvoiceRef,
      subscriptionId: subscription.id,
      reversalEventId: event.providerEventId,
      amountLabel: "Stripe subscription reversal",
      durationDays: 0,
      reviewedAt: eventProviderCreatedAt(event),
    })
    .onConflictDoNothing({
      target: [paymentRequests.provider, paymentRequests.providerInvoiceRef],
      where: sql.raw("provider_invoice_ref is not null"),
    });
}

async function applySubscriptionActivated(
  tx: TxClient,
  provider: string,
  event: Extract<NormalizedPaymentEvent, { type: "subscription_activated" }>,
): Promise<void> {
  const eventAt = event.providerCreatedAt;
  const conditions = [];
  if (event.localSubscriptionId) conditions.push(eq(subscriptions.id, event.localSubscriptionId));
  conditions.push(eq(subscriptions.providerSubscriptionRef, event.providerSubscriptionRef));

  await tx
    .update(subscriptions)
    .set({
      status: "active",
      provider,
      providerSubscriptionRef: event.providerSubscriptionRef,
      providerCustomerRef: event.providerCustomerRef,
      currentPeriodEndsAt: event.currentPeriodEndsAt,
      cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      statusEventAt: eventAt,
      updatedAt: eventAt,
      version: sql`${subscriptions.version} + 1`,
    })
    .where(
      and(
        or(...conditions),
        or(sql`${subscriptions.statusEventAt} is null`, lte(subscriptions.statusEventAt, eventAt)),
      ),
    );
}

async function applySubscriptionPaymentFailed(
  tx: TxClient,
  event: SubscriptionPaymentFailedEvent,
): Promise<void> {
  if (!event.localSubscriptionId && !event.providerSubscriptionRef) return;
  const eventAt = event.providerCreatedAt;
  const conditions = [];
  if (event.localSubscriptionId) conditions.push(eq(subscriptions.id, event.localSubscriptionId));
  if (event.providerSubscriptionRef) {
    conditions.push(eq(subscriptions.providerSubscriptionRef, event.providerSubscriptionRef));
  }
  await tx
    .update(subscriptions)
    .set({
      status: "past_due",
      statusEventAt: eventAt,
      updatedAt: eventAt,
      version: sql`${subscriptions.version} + 1`,
    })
    .where(
      and(
        or(...conditions),
        or(sql`${subscriptions.statusEventAt} is null`, lte(subscriptions.statusEventAt, eventAt)),
      ),
    );
}

async function applySubscriptionCanceled(
  tx: TxClient,
  event: SubscriptionCanceledPaymentEvent,
): Promise<void> {
  const eventAt = event.providerCreatedAt;
  await tx
    .update(subscriptions)
    .set({
      status: "canceled",
      canceledAt: event.canceledAt ?? eventAt,
      statusEventAt: eventAt,
      updatedAt: eventAt,
      version: sql`${subscriptions.version} + 1`,
    })
    .where(
      and(
        eq(subscriptions.providerSubscriptionRef, event.providerSubscriptionRef),
        or(sql`${subscriptions.statusEventAt} is null`, lte(subscriptions.statusEventAt, eventAt)),
      ),
    );
}

async function applyProviderEventInTransaction(
  tx: TxClient,
  provider: string,
  resolved: ResolvedProviderEvent,
): Promise<void> {
  const event = resolved.event;
  switch (event.type) {
    case "paid":
      await confirmAutoPayment(provider, event, tx);
      return;
    case "expired":
      await expireAutoPayment(provider, event, tx);
      return;
    case "refunded":
    case "disputed":
      if (event.providerInvoiceRef) {
        await applySubscriptionReversalOrTombstone(tx, provider, event);
      } else {
        await reverseAutoPayment(provider, event, tx, resolved.oneTimeCheckout);
      }
      return;
    case "subscription_renewed":
      await applyPaidInvoice(tx, provider, event);
      return;
    case "subscription_activated":
      await applySubscriptionActivated(tx, provider, event);
      return;
    case "subscription_payment_failed":
      await applySubscriptionPaymentFailed(tx, event);
      return;
    case "subscription_canceled":
      await applySubscriptionCanceled(tx, event);
      return;
    case "ignored":
      return;
  }
}

export async function createSubscriptionCheckout(
  input: SubscriptionCheckoutInput,
): Promise<{ redirectUrl: string }> {
  const db = getDb();
  const [tier] = await db
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.id, input.tierId))
    .limit(1);
  if (
    !tier ||
    !tier.isActive ||
    !tier.stripePriceId ||
    tier.priceAmountMinor === null ||
    !tier.currency
  ) {
    throw new ApiError(400, "tierNotSubscribable");
  }
  const currency = tier.currency.toLowerCase();

  const provider = await getPaymentProvider("stripe", { requireEnabled: true });
  if (!provider?.createSubscriptionCheckout || !provider.getSubscriptionCheckoutState) {
    throw new ApiError(400, "paymentProviderUnsupported");
  }

  const claimToken = `creating:${randomUUID()}`;
  const claim = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`subscription-checkout:${input.userId}:${input.tierId}:stripe`}))`,
    );
    const [existing] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, input.userId),
          eq(subscriptions.tierId, input.tierId),
          eq(subscriptions.provider, "stripe"),
          sql`${subscriptions.status} not in ('canceled', 'expired')`,
        ),
      )
      .limit(1)
      .for("update");
    if (existing && (existing.status === "active" || existing.status === "past_due")) {
      throw new ApiError(400, "subscriptionAlreadyActive");
    }
    if (existing?.providerCheckoutRef) {
      return { subscription: existing, claimToken: null };
    }
    if (existing?.checkoutClaimToken) {
      const [reclaimed] = await tx
        .update(subscriptions)
        .set({
          checkoutClaimToken: claimToken,
          checkoutClaimedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(subscriptions.id, existing.id),
            eq(subscriptions.status, "pending"),
            eq(subscriptions.checkoutClaimToken, existing.checkoutClaimToken),
            sql`${subscriptions.checkoutClaimedAt} < now() - (${SUBSCRIPTION_CHECKOUT_CLAIM_LEASE_MS} * interval '1 millisecond')`,
          ),
        )
        .returning();
      if (!reclaimed) throw new ApiError(409, "subscriptionCheckoutChanged");
      return { subscription: reclaimed, claimToken };
    }
    if (existing) {
      const [claimed] = await tx
        .update(subscriptions)
        .set({
          checkoutClaimToken: claimToken,
          checkoutClaimedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(subscriptions.id, existing.id), eq(subscriptions.status, "pending")))
        .returning();
      if (!claimed) throw new ApiError(409, "subscriptionCheckoutChanged");
      return { subscription: claimed, claimToken };
    }

    const [created] = await tx
      .insert(subscriptions)
      .values({
        userId: input.userId,
        tierId: input.tierId,
        status: "pending",
        provider: "stripe",
        providerPriceRef: tier.stripePriceId,
        expectedAmountMinor: tier.priceAmountMinor,
        expectedCurrency: currency,
        quantity: 1,
        checkoutClaimToken: claimToken,
        checkoutClaimedAt: sql`now()`,
      })
      .onConflictDoNothing({
        target: [subscriptions.userId, subscriptions.tierId, subscriptions.provider],
        where: sql.raw("status not in ('canceled', 'expired')"),
      })
      .returning();
    if (!created) throw new ApiError(400, "subscriptionAlreadyExists");
    await enqueueSubscriptionReconcileTask(tx);
    return { subscription: created, claimToken };
  });

  if (!claim.claimToken) {
    const checkout = await provider.getSubscriptionCheckoutState(
      claim.subscription.providerCheckoutRef!,
    );
    if (checkout.status === "open" && checkout.redirectUrl)
      return { redirectUrl: checkout.redirectUrl };
    if (checkout.providerSubscriptionRef) throw new ApiError(400, "subscriptionAlreadyActive");
    await db
      .update(subscriptions)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(subscriptions.id, claim.subscription.id), eq(subscriptions.status, "pending")));
    return createSubscriptionCheckout(input);
  }

  try {
    const checkout = await provider.createSubscriptionCheckout({
      subscriptionId: claim.subscription.id,
      priceRef: claim.subscription.providerPriceRef!,
      providerPriceRef: claim.subscription.providerPriceRef!,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
    const [updated] = await db
      .update(subscriptions)
      .set({
        providerCheckoutRef: checkout.providerCheckoutRef,
        checkoutClaimToken: null,
        checkoutClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(subscriptions.id, claim.subscription.id),
          eq(subscriptions.status, "pending"),
          eq(subscriptions.checkoutClaimToken, claim.claimToken),
        ),
      )
      .returning({ id: subscriptions.id });
    if (!updated) throw new ApiError(409, "subscriptionCheckoutChanged");
    return { redirectUrl: checkout.redirectUrl };
  } catch (error) {
    await db
      .update(subscriptions)
      .set({ checkoutClaimToken: null, checkoutClaimedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(subscriptions.id, claim.subscription.id),
          eq(subscriptions.status, "pending"),
          eq(subscriptions.checkoutClaimToken, claim.claimToken),
        ),
      );
    throw error;
  }
}

export async function cancelMySubscription(input: {
  userId: string;
  subscriptionId: string;
}): Promise<Subscription> {
  const provider = await getPaymentProvider("stripe", { requireEnabled: true });
  if (!provider?.cancelSubscription) throw new ApiError(400, "paymentProviderUnsupported");

  const [subscription] = await getDb()
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, input.subscriptionId), eq(subscriptions.userId, input.userId)))
    .limit(1);
  if (!subscription) throw new ApiError(404, "subscriptionNotFound");
  if (!subscription.providerSubscriptionRef) throw new ApiError(400, "subscriptionNotActive");

  await provider.cancelSubscription(subscription.providerSubscriptionRef, { atPeriodEnd: true });
  const [updated] = await getDb()
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
    .where(and(eq(subscriptions.id, subscription.id), eq(subscriptions.userId, input.userId)))
    .returning();
  if (!updated) throw new ApiError(404, "subscriptionNotFound");
  return updated;
}

export async function reconcileSubscriptions(): Promise<number> {
  const provider = await getPaymentProvider("stripe", { requireEnabled: true });
  if (
    !provider?.getSubscriptionCheckoutState ||
    !provider.retrieveSubscription ||
    !provider.listPaidSubscriptionInvoices
  ) {
    throw new ApiError(400, "paymentProviderUnsupported");
  }

  const cutoff = new Date(Date.now() - RECENT_TERMINAL_RECONCILE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select()
    .from(subscriptions)
    .where(
      or(
        inArray(subscriptions.status, ["pending", "active", "past_due"]),
        and(
          inArray(subscriptions.status, ["canceled", "expired"]),
          gte(subscriptions.updatedAt, cutoff),
        ),
      ),
    );

  let processed = 0;
  for (const subscription of rows) {
    let providerSubscriptionRef = subscription.providerSubscriptionRef;
    if (!providerSubscriptionRef && subscription.providerCheckoutRef) {
      const checkout = await provider.getSubscriptionCheckoutState(
        subscription.providerCheckoutRef,
      );
      if (checkout.status === "expired") {
        await getDb()
          .update(subscriptions)
          .set({ status: "expired", updatedAt: new Date() })
          .where(and(eq(subscriptions.id, subscription.id), eq(subscriptions.status, "pending")));
        processed += 1;
        continue;
      }
      providerSubscriptionRef = checkout.providerSubscriptionRef;
      if (providerSubscriptionRef) {
        await getDb()
          .update(subscriptions)
          .set({ providerSubscriptionRef, updatedAt: new Date() })
          .where(eq(subscriptions.id, subscription.id));
      }
    }
    if (!providerSubscriptionRef || !subscription.providerPriceRef) continue;

    const remote = await provider.retrieveSubscription(providerSubscriptionRef);
    // Advance the ordering fence to the provider-clock observation fence
    // (`observedAt`), in the same clock domain as webhook `providerCreatedAt`
    // (issue #112 / reproduced in #102). Both sides are second-granularity Stripe
    // timestamps, anchored at opposite ends of their second: webhook
    // `providerCreatedAt` is `event.created * 1000`, the START of its second
    // (S.000), while `observedAt` arrives here already normalized by
    // `getPaymentProvider()` to the END of the observed second (S.999, see
    // `providerObservationFence`).
    //
    // The guard is a STRICT `<` evaluated against the live row at update time, which
    // both orders the external-I/O race and defines the tie policy without a version
    // CAS:
    //   - a webhook that committed from a LATER provider second ((S+1).000 > S.999)
    //     leaves statusEventAt not-strictly-below observedAt, so reconcile skips and
    //     the newer event wins;
    //   - a webhook that committed from the observed second or earlier (at most
    //     S.000, strictly below the S.999 fence) is superseded, so reconcile wins.
    // Provider ordering therefore governs, not commit timing. Within one provider
    // second the OBSERVATION wins, by construction: a same-second webhook's S.000
    // can neither survive this strict-`<` overwrite nor pass its own
    // `statusEventAt <= providerCreatedAt` gate against an S.999 fence; only a
    // webhook from the next provider second exceeds the fence. A genuinely later
    // same-second change converges on a subsequent reconcile observation from a
    // later provider second (an observation of the SAME second re-normalizes to
    // the identical S.999 fence, which the strict `<` skips). Webhook-vs-
    // webhook ordering is unaffected (whole-second timestamps, `<=` gate — equal
    // seconds reapply); only reconcile fences carry the fractional end-of-second
    // marker.
    //
    // Fail closed if the provider gives no observation timestamp: skip the
    // status/fence write rather than fall back to local time (which would mix clock
    // domains). Invoice reconciliation below still runs.
    if (remote.observedAt) {
      await getDb()
        .update(subscriptions)
        .set({
          status: remote.status,
          providerCustomerRef: remote.providerCustomerRef,
          currentPeriodEndsAt: remote.currentPeriodEndsAt,
          cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
          statusEventAt: remote.observedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(subscriptions.id, subscription.id),
            or(
              sql`${subscriptions.statusEventAt} is null`,
              lt(subscriptions.statusEventAt, remote.observedAt),
            ),
          ),
        );
    }

    const invoices = await provider.listPaidSubscriptionInvoices(
      providerSubscriptionRef,
      subscription.providerPriceRef,
      subscription.id,
    );
    for (const invoice of invoices) {
      await getDb().transaction((tx) => applyPaidInvoice(tx, "stripe", invoice));
    }
    processed += 1;
  }
  return processed;
}
