import { z } from "zod";

import { ApiError } from "@/lib/api";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

export const STRIPE_GROUP = "stripe";

export const stripeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  secretKey: z.string().optional(),
  webhookSecret: z.string().optional(),
  publishableKey: z.string().optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toLowerCase())
    .optional(),
});
export type StripeConfigInput = z.infer<typeof stripeConfigSchema>;

export type ResolvedStripeConfig = {
  enabled: boolean;
  secretKey?: string;
  webhookSecret?: string;
  publishableKey?: string;
  currency: string;
  configured: boolean;
};

export type StripeAdminView = {
  enabled: boolean;
  publishableKey?: string;
  currency: string;
  configured: boolean;
  secretKeySet: boolean;
  webhookSecretSet: boolean;
  hasDbOverride: boolean;
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export async function getStripeConfig(): Promise<ResolvedStripeConfig> {
  const stored = (await getStoredGroup<StripeConfigInput>(STRIPE_GROUP)) ?? {};
  const secretKey = nonEmpty(stored.secretKey);
  const webhookSecret = nonEmpty(stored.webhookSecret);
  return {
    enabled: stored.enabled ?? false,
    secretKey,
    webhookSecret,
    publishableKey: nonEmpty(stored.publishableKey),
    currency: nonEmpty(stored.currency)?.toLowerCase() ?? "usd",
    configured: Boolean(secretKey && webhookSecret),
  };
}

export async function getStripeAdminView(): Promise<StripeAdminView> {
  const [effective, stored] = await Promise.all([
    getStripeConfig(),
    getStoredGroup<StripeConfigInput>(STRIPE_GROUP),
  ]);
  return {
    enabled: effective.enabled,
    publishableKey: effective.publishableKey,
    currency: effective.currency,
    configured: effective.configured,
    secretKeySet: Boolean(effective.secretKey),
    webhookSecretSet: Boolean(effective.webhookSecret),
    hasDbOverride: stored !== null,
  };
}

export async function saveStripeConfig(input: StripeConfigInput): Promise<void> {
  const existing = (await getStoredGroup<StripeConfigInput>(STRIPE_GROUP)) ?? {};
  const next: StripeConfigInput = {
    enabled: input.enabled ?? existing.enabled ?? false,
    secretKey: nonEmpty(input.secretKey) ?? nonEmpty(existing.secretKey),
    webhookSecret: nonEmpty(input.webhookSecret) ?? nonEmpty(existing.webhookSecret),
    publishableKey:
      input.publishableKey === undefined
        ? nonEmpty(existing.publishableKey)
        : nonEmpty(input.publishableKey),
    currency:
      input.currency === undefined
        ? (nonEmpty(existing.currency)?.toLowerCase() ?? "usd")
        : input.currency.toLowerCase(),
  };

  if (next.enabled && (!next.secretKey || !next.webhookSecret)) {
    throw new ApiError(400, "stripeConfigIncomplete");
  }
  await setStoredGroup<StripeConfigInput>(STRIPE_GROUP, next);
}

export async function clearStripeConfig(): Promise<void> {
  await deleteStoredGroup(STRIPE_GROUP);
}
