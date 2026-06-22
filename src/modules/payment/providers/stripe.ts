import Stripe from "stripe";

import { ApiError } from "@/lib/api";

import type { NormalizedPaymentEvent, PaymentProvider } from "./index";

type StripeClient = Pick<Stripe, "balance" | "checkout" | "webhooks">;

function objectId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
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
        return { type: "ignored", providerEventId: event.id };
      }
      const paymentRef = objectId(charge.payment_intent);
      if (!paymentRef) return { type: "ignored", providerEventId: event.id };
      return {
        type: "refunded",
        paymentRef,
        providerEventId: event.id,
      };
    }

    if (event.type === "charge.dispute.created") {
      const dispute = event.data.object as Stripe.Dispute;
      const paymentRef = objectId(dispute.payment_intent);
      if (!paymentRef) return { type: "ignored", providerEventId: event.id };
      return {
        type: "disputed",
        paymentRef,
        providerEventId: event.id,
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
      };
    }

    if (event.type !== "checkout.session.completed") {
      return { type: "ignored", providerEventId: event.id };
    }

    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== "paid") {
      return { type: "ignored", providerEventId: event.id };
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

  async testConnection(): Promise<void> {
    await this.client.balance.retrieve();
  }
}
