import Stripe from "stripe";

import { ApiError } from "@/lib/api";

import type {
  NormalizedPaymentEvent,
  PaymentProvider,
  SubscriptionRenewedPaymentEvent,
} from "./index";

type StripeClient = Pick<
  Stripe,
  "balance" | "charges" | "checkout" | "invoices" | "subscriptions" | "webhooks"
>;

function objectId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function eventCreatedAt(event: Stripe.Event): Date {
  return new Date((event.created ?? 0) * 1000);
}

function subscriptionCurrentPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const periodEnd = (subscription as unknown as { current_period_end?: number }).current_period_end;
  return typeof periodEnd === "number" ? new Date(periodEnd * 1000) : null;
}

// The provider server clock at which an API resource was returned (its HTTP
// `Date` header). Used as the reconcile observation timestamp so it shares the
// clock domain with webhook `providerCreatedAt`.
function stripeResponseDate(resource: {
  lastResponse?: { headers?: Record<string, string> };
}): Date | null {
  const raw = resource.lastResponse?.headers?.date;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function subscriptionMetadata(subscription: Stripe.Subscription): Record<string, string> {
  return (subscription.metadata ?? {}) as Record<string, string>;
}

function invoiceMetadata(invoice: Stripe.Invoice): Record<string, string> {
  return (invoice.metadata ?? {}) as Record<string, string>;
}

function invoicePaymentRef(invoice: Stripe.Invoice): string | null {
  return objectId(
    (invoice as unknown as { payment_intent?: string | { id: string } | null }).payment_intent,
  );
}

function invoiceSubscriptionRef(invoice: Stripe.Invoice): string | null {
  return objectId(
    (invoice as unknown as { subscription?: string | { id: string } | null }).subscription,
  );
}

function linePriceRef(line: Stripe.InvoiceLineItem): string | null {
  return objectId((line as unknown as { price?: string | { id: string } | null }).price);
}

function invoicePeriod(line: Stripe.InvoiceLineItem): { start: Date; end: Date } | null {
  if (!line.period?.start || !line.period?.end || line.period.end <= line.period.start) return null;
  return { start: new Date(line.period.start * 1000), end: new Date(line.period.end * 1000) };
}

function normalizeStripeSubscriptionStatus(
  status: Stripe.Subscription.Status | string | null | undefined,
): "active" | "past_due" | "canceled" | "expired" | "pending" {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "canceled") return "canceled";
  if (status === "incomplete_expired") return "expired";
  return "pending";
}

function normalizeSubscriptionInvoice(
  invoice: Stripe.Invoice,
  providerEventId: string,
  providerCreatedAt: Date,
  localSubscriptionId?: string,
): SubscriptionRenewedPaymentEvent {
  const providerSubscriptionRef = invoiceSubscriptionRef(invoice);
  if (!invoice.id || !providerSubscriptionRef || !invoice.currency) {
    throw new ApiError(422, "stripeEventInvalid");
  }

  const lines = invoice.lines.data.flatMap((line) => {
    const providerPriceRef = linePriceRef(line);
    const period = invoicePeriod(line);
    if (!providerPriceRef || !period) return [];
    return [
      {
        providerPriceRef,
        periodStart: period.start,
        periodEnd: period.end,
        amountMinor: line.amount,
      },
    ];
  });
  if (lines.length === 0) throw new ApiError(422, "stripeInvoiceLineInvalid");

  return {
    type: "subscription_renewed",
    localSubscriptionId:
      localSubscriptionId || invoiceMetadata(invoice).subscriptionId || undefined,
    providerSubscriptionRef,
    providerInvoiceRef: invoice.id,
    providerPaymentRef: invoicePaymentRef(invoice),
    providerPriceRef: invoiceMetadata(invoice).providerPriceRef || undefined,
    lines,
    currency: invoice.currency.toLowerCase(),
    providerEventId,
    providerCreatedAt,
  };
}

export class StripePaymentProvider implements PaymentProvider {
  readonly id = "stripe" as const;
  private readonly client: StripeClient;

  constructor(
    private readonly config: { secretKey: string; webhookSecret: string },
    client?: StripeClient,
  ) {
    this.client = client ?? new Stripe(config.secretKey);
  }

  async createCheckout(input: {
    requestId: string;
    amountMinor: number;
    currency: string;
    tierName: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ redirectUrl: string; providerRef: string }> {
    const session = await this.client.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: input.currency,
              unit_amount: input.amountMinor,
              product_data: { name: input.tierName },
            },
            quantity: 1,
          },
        ],
        metadata: {
          requestId: input.requestId,
          app: "openlayerlypro",
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: `checkout:${input.requestId}` },
    );
    if (!session.url) throw new ApiError(502, "stripeCheckoutUnavailable");
    return { redirectUrl: session.url, providerRef: session.id };
  }

  async createSubscriptionCheckout(input: {
    subscriptionId: string;
    priceRef: string;
    providerPriceRef?: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ redirectUrl: string; providerCheckoutRef: string }> {
    const metadata = {
      subscriptionId: input.subscriptionId,
      providerPriceRef: input.providerPriceRef ?? input.priceRef,
      app: "openlayerlypro",
    };
    const session = await this.client.checkout.sessions.create(
      {
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: input.priceRef, quantity: 1 }],
        metadata,
        subscription_data: {
          metadata,
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: `subscription-checkout:${input.subscriptionId}` },
    );
    if (!session.url) throw new ApiError(502, "stripeCheckoutUnavailable");
    return { redirectUrl: session.url, providerCheckoutRef: session.id };
  }

  async cancelSubscription(
    providerSubscriptionRef: string,
    options: { atPeriodEnd: boolean },
  ): Promise<void> {
    if (options.atPeriodEnd) {
      await this.client.subscriptions.update(providerSubscriptionRef, {
        cancel_at_period_end: true,
      });
      return;
    }
    await this.client.subscriptions.cancel(providerSubscriptionRef);
  }

  async parseWebhook(rawBody: Buffer, signature: string | null): Promise<NormalizedPaymentEvent> {
    if (!signature) throw new ApiError(401, "stripeSignatureInvalid");

    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
    } catch {
      throw new ApiError(401, "stripeSignatureInvalid");
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      if (!charge.refunded || charge.amount_refunded !== charge.amount) {
        return {
          type: "ignored",
          providerEventId: event.id,
          providerCreatedAt: eventCreatedAt(event),
        };
      }
      const paymentRef = objectId(charge.payment_intent);
      if (!paymentRef) {
        return {
          type: "ignored",
          providerEventId: event.id,
          providerCreatedAt: eventCreatedAt(event),
        };
      }
      return {
        type: "refunded",
        paymentRef,
        providerInvoiceRef:
          objectId((charge as unknown as { invoice?: string | { id: string } | null }).invoice) ??
          undefined,
        providerEventId: event.id,
        providerCreatedAt: eventCreatedAt(event),
      };
    }

    if (event.type === "charge.dispute.created") {
      const dispute = event.data.object as Stripe.Dispute;
      const paymentRef = objectId(dispute.payment_intent);
      if (!paymentRef) {
        return {
          type: "ignored",
          providerEventId: event.id,
          providerCreatedAt: eventCreatedAt(event),
        };
      }
      return {
        type: "disputed",
        paymentRef,
        providerInvoiceRef:
          objectId((dispute as unknown as { invoice?: string | { id: string } | null }).invoice) ??
          undefined,
        providerEventId: event.id,
        providerCreatedAt: eventCreatedAt(event),
      };
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (!session.id) throw new ApiError(422, "stripeEventInvalid");
      return {
        type: "expired",
        providerRef: session.id,
        requestId: session.metadata?.requestId || undefined,
        providerEventId: event.id,
        providerCreatedAt: eventCreatedAt(event),
      };
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const subscription = event.data.object as Stripe.Subscription;
      if (!subscription.id) throw new ApiError(422, "stripeEventInvalid");
      return {
        type: "subscription_activated",
        localSubscriptionId: subscriptionMetadata(subscription).subscriptionId || undefined,
        providerSubscriptionRef: subscription.id,
        providerCustomerRef: objectId(subscription.customer),
        currentPeriodEndsAt: subscriptionCurrentPeriodEnd(subscription),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        providerEventId: event.id,
        providerCreatedAt: eventCreatedAt(event),
      };
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      const localSubscriptionId = invoiceMetadata(invoice).subscriptionId || undefined;
      const subscriptionRef = invoiceSubscriptionRef(invoice);
      if (!subscriptionRef) {
        return {
          type: "ignored",
          providerEventId: event.id,
          providerCreatedAt: eventCreatedAt(event),
        };
      }
      return normalizeSubscriptionInvoice(
        invoice,
        event.id,
        eventCreatedAt(event),
        localSubscriptionId,
      );
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      return {
        type: "subscription_payment_failed",
        localSubscriptionId: invoiceMetadata(invoice).subscriptionId || undefined,
        providerSubscriptionRef: invoiceSubscriptionRef(invoice),
        providerInvoiceRef: invoice.id ?? null,
        providerEventId: event.id,
        providerCreatedAt: eventCreatedAt(event),
      };
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      if (!subscription.id) throw new ApiError(422, "stripeEventInvalid");
      return {
        type: "subscription_canceled",
        localSubscriptionId: subscriptionMetadata(subscription).subscriptionId || undefined,
        providerSubscriptionRef: subscription.id,
        canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
        providerEventId: event.id,
        providerCreatedAt: eventCreatedAt(event),
      };
    }

    if (event.type !== "checkout.session.completed") {
      return {
        type: "ignored",
        providerEventId: event.id,
        providerCreatedAt: eventCreatedAt(event),
      };
    }

    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== "paid") {
      return {
        type: "ignored",
        providerEventId: event.id,
        providerCreatedAt: eventCreatedAt(event),
      };
    }
    const paymentRef = objectId(session.payment_intent);
    if (!session.id || session.amount_total === null || !session.currency || !paymentRef) {
      throw new ApiError(422, "stripeEventInvalid");
    }
    return {
      type: "paid",
      providerRef: session.id,
      paymentRef,
      requestId: session.metadata?.requestId || undefined,
      providerEventId: event.id,
      providerCreatedAt: eventCreatedAt(event),
      amountMinor: session.amount_total,
      currency: session.currency.toLowerCase(),
    };
  }

  async resolveCheckoutByPaymentIntent(paymentRef: string): Promise<{
    providerRef: string;
    requestId?: string;
    owned: boolean;
  } | null> {
    const sessions = await this.client.checkout.sessions.list({
      payment_intent: paymentRef,
      limit: 1,
    });
    const session = sessions.data[0];
    if (!session) return null;
    return {
      providerRef: session.id,
      requestId: session.metadata?.requestId || undefined,
      owned: session.metadata?.app === "openlayerlypro",
    };
  }

  async getCheckoutState(providerRef: string): Promise<{
    status: "open" | "complete" | "expired";
    redirectUrl: string | null;
  }> {
    const session = await this.client.checkout.sessions.retrieve(providerRef);
    if (!session.status) throw new ApiError(502, "stripeEventInvalid");
    return {
      status: session.status,
      redirectUrl: session.status === "open" ? session.url : null,
    };
  }

  async getSubscriptionCheckoutState(providerRef: string): Promise<{
    status: "open" | "complete" | "expired";
    redirectUrl: string | null;
    providerSubscriptionRef: string | null;
  }> {
    const session = await this.client.checkout.sessions.retrieve(providerRef);
    if (!session.status) throw new ApiError(502, "stripeEventInvalid");
    return {
      status: session.status,
      redirectUrl: session.status === "open" ? session.url : null,
      providerSubscriptionRef: objectId(session.subscription),
    };
  }

  async retrieveSubscription(providerSubscriptionRef: string): Promise<{
    status: "active" | "past_due" | "canceled" | "expired" | "pending";
    providerSubscriptionRef: string;
    providerCustomerRef: string | null;
    currentPeriodEndsAt: Date | null;
    cancelAtPeriodEnd: boolean;
    observedAt: Date | null;
  }> {
    const subscription = await this.client.subscriptions.retrieve(providerSubscriptionRef);
    return {
      status: normalizeStripeSubscriptionStatus(subscription.status),
      providerSubscriptionRef: subscription.id,
      providerCustomerRef: objectId(subscription.customer),
      currentPeriodEndsAt: subscriptionCurrentPeriodEnd(subscription),
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      // Provider server clock at which this state was observed (the API response
      // `Date` header). Any webhook event created at or before this instant is
      // already reflected here. `null` (missing/invalid header) makes reconcile
      // fail closed — it never substitutes local time, which would mix clocks.
      observedAt: stripeResponseDate(subscription),
    };
  }

  async listPaidSubscriptionInvoices(
    providerSubscriptionRef: string,
    _providerPriceRef: string,
    localSubscriptionId?: string,
  ): Promise<SubscriptionRenewedPaymentEvent[]> {
    const invoices = await this.client.invoices.list({
      subscription: providerSubscriptionRef,
      status: "paid",
      limit: 100,
    } as Stripe.InvoiceListParams);
    return invoices.data.map((invoice) =>
      normalizeSubscriptionInvoice(
        invoice,
        `reconcile:${invoice.id}`,
        new Date(),
        localSubscriptionId,
      ),
    );
  }

  async resolveInvoiceByPaymentIntent(paymentRef: string): Promise<{
    providerInvoiceRef: string;
    providerSubscriptionRef: string | null;
    localSubscriptionId?: string;
  } | null> {
    const charges = await this.client.charges.list({ payment_intent: paymentRef, limit: 1 });
    const charge = charges.data[0];
    const invoiceId = charge
      ? objectId((charge as unknown as { invoice?: string | { id: string } | null }).invoice)
      : null;
    if (!invoiceId) return null;
    const invoice = await this.client.invoices.retrieve(invoiceId);
    return {
      providerInvoiceRef: invoiceId,
      providerSubscriptionRef: invoiceSubscriptionRef(invoice),
      localSubscriptionId: invoiceMetadata(invoice).subscriptionId || undefined,
    };
  }

  async testConnection(): Promise<void> {
    await this.client.balance.retrieve();
  }
}
