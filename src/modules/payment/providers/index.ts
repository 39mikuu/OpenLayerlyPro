import { ApiError } from "@/lib/api";
import { getStripeConfig } from "@/modules/config";

import { StripePaymentProvider } from "./stripe";

export type PaidPaymentEvent = {
  type: "paid";
  providerRef: string;
  requestId?: string;
  providerEventId: string;
  amountMinor: number;
  currency: string;
};

export type NormalizedPaymentEvent =
  | PaidPaymentEvent
  | { type: "ignored"; providerEventId: string };

export interface PaymentProvider {
  id: "stripe";
  createCheckout(input: {
    requestId: string;
    amountMinor: number;
    currency: string;
    tierName: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ redirectUrl: string; providerRef: string }>;
  getCheckoutState(providerRef: string): Promise<{
    status: "open" | "complete" | "expired";
    redirectUrl: string | null;
  }>;
  parseWebhook(rawBody: string, signature: string | null): Promise<NormalizedPaymentEvent>;
  testConnection(): Promise<void>;
}

export async function getPaymentProvider(
  id: string,
  options: { requireEnabled?: boolean } = {},
): Promise<PaymentProvider | null> {
  if (id !== "stripe") return null;
  const config = await getStripeConfig();
  if (!config.configured || !config.secretKey || !config.webhookSecret) {
    throw new ApiError(400, "stripeConfigIncomplete");
  }
  if (options.requireEnabled && !config.enabled) {
    throw new ApiError(400, "stripeDisabled");
  }
  return new StripePaymentProvider({
    secretKey: config.secretKey,
    webhookSecret: config.webhookSecret,
  });
}

export async function testStripeConnection(): Promise<void> {
  const provider = await getPaymentProvider("stripe");
  await provider!.testConnection();
}

export { StripePaymentProvider } from "./stripe";
