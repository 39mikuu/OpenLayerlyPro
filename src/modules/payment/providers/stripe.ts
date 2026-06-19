import Stripe from "stripe";

import { ApiError } from "@/lib/api";

import type { NormalizedPaymentEvent, PaymentProvider } from "./index";

type StripeClient = Pick<Stripe, "balance" | "checkout" | "webhooks">;

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
    const session = await this.client.checkout.sessions.create({
      mode: "payment",
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
      metadata: { requestId: input.requestId },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new ApiError(502, "stripeCheckoutUnavailable");
    return { redirectUrl: session.url, providerRef: session.id };
  }

  async parseWebhook(rawBody: string, signature: string | null): Promise<NormalizedPaymentEvent> {
    if (!signature) throw new ApiError(401, "stripeSignatureInvalid");

    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
    } catch {
      throw new ApiError(401, "stripeSignatureInvalid");
    }

    if (event.type !== "checkout.session.completed") {
      return { type: "ignored", providerEventId: event.id };
    }
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== "paid") {
      return { type: "ignored", providerEventId: event.id };
    }
    if (!session.id || session.amount_total === null || !session.currency) {
      throw new ApiError(422, "stripeEventInvalid");
    }
    return {
      type: "paid",
      providerRef: session.id,
      requestId: session.metadata?.requestId || undefined,
      providerEventId: event.id,
      amountMinor: session.amount_total,
      currency: session.currency.toLowerCase(),
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
