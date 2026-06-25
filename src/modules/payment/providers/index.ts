import { ApiError } from "@/lib/api";
import { getStripeConfig } from "@/modules/config";

import { StripePaymentProvider } from "./stripe";

export type PaidPaymentEvent = {
  type: "paid";
  providerRef: string;
  paymentRef: string;
  requestId?: string;
  providerEventId: string;
  providerCreatedAt?: Date;
  amountMinor: number;
  currency: string;
};

export type ExpiredPaymentEvent = {
  type: "expired";
  providerRef: string;
  requestId?: string;
  providerEventId: string;
  providerCreatedAt?: Date;
};

export type RefundedPaymentEvent = {
  type: "refunded";
  paymentRef: string;
  providerInvoiceRef?: string;
  providerEventId: string;
  providerCreatedAt?: Date;
};

export type DisputedPaymentEvent = {
  type: "disputed";
  paymentRef: string;
  providerInvoiceRef?: string;
  providerEventId: string;
  providerCreatedAt?: Date;
};

export type ReversalPaymentEvent = RefundedPaymentEvent | DisputedPaymentEvent;

export type SubscriptionRenewedPaymentEvent = {
  type: "subscription_renewed";
  localSubscriptionId?: string;
  providerSubscriptionRef: string;
  providerInvoiceRef: string;
  providerPaymentRef: string | null;
  providerPriceRef?: string;
  lines: {
    providerPriceRef: string;
    periodStart: Date;
    periodEnd: Date;
    amountMinor: number;
  }[];
  currency: string;
  providerEventId: string;
  providerCreatedAt: Date;
};

export type SubscriptionActivatedPaymentEvent = {
  type: "subscription_activated";
  localSubscriptionId?: string;
  providerSubscriptionRef: string;
  providerCustomerRef: string | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  providerEventId: string;
  providerCreatedAt: Date;
};

export type SubscriptionPaymentFailedEvent = {
  type: "subscription_payment_failed";
  localSubscriptionId?: string;
  providerSubscriptionRef: string | null;
  providerInvoiceRef: string | null;
  providerEventId: string;
  providerCreatedAt: Date;
};

export type SubscriptionCanceledPaymentEvent = {
  type: "subscription_canceled";
  localSubscriptionId?: string;
  providerSubscriptionRef: string;
  canceledAt: Date | null;
  providerEventId: string;
  providerCreatedAt: Date;
};

export type SubscriptionPaymentEvent =
  | SubscriptionRenewedPaymentEvent
  | SubscriptionActivatedPaymentEvent
  | SubscriptionPaymentFailedEvent
  | SubscriptionCanceledPaymentEvent;

export type NormalizedPaymentEvent =
  | PaidPaymentEvent
  | ExpiredPaymentEvent
  | ReversalPaymentEvent
  | SubscriptionPaymentEvent
  | { type: "ignored"; providerEventId: string; providerCreatedAt?: Date };

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
  createSubscriptionCheckout?(input: {
    subscriptionId: string;
    priceRef: string;
    providerPriceRef?: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ redirectUrl: string; providerCheckoutRef: string }>;
  cancelSubscription?(
    providerSubscriptionRef: string,
    options: { atPeriodEnd: boolean },
  ): Promise<void>;
  getCheckoutState(providerRef: string): Promise<{
    status: "open" | "complete" | "expired";
    redirectUrl: string | null;
  }>;
  getSubscriptionCheckoutState?(providerRef: string): Promise<{
    status: "open" | "complete" | "expired";
    redirectUrl: string | null;
    providerSubscriptionRef: string | null;
  }>;
  retrieveSubscription?(providerSubscriptionRef: string): Promise<{
    status: "active" | "past_due" | "canceled" | "expired" | "pending";
    providerSubscriptionRef: string;
    providerCustomerRef: string | null;
    currentPeriodEndsAt: Date | null;
    cancelAtPeriodEnd: boolean;
  }>;
  listPaidSubscriptionInvoices?(
    providerSubscriptionRef: string,
    providerPriceRef: string,
    localSubscriptionId?: string,
  ): Promise<SubscriptionRenewedPaymentEvent[]>;
  resolveInvoiceByPaymentIntent?(paymentRef: string): Promise<{
    providerInvoiceRef: string;
    providerSubscriptionRef: string | null;
    localSubscriptionId?: string;
  } | null>;
  parseWebhook(rawBody: Buffer, signature: string | null): Promise<NormalizedPaymentEvent>;
  resolveCheckoutByPaymentIntent(paymentRef: string): Promise<{
    providerRef: string;
    requestId?: string;
    owned: boolean;
  } | null>;
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
