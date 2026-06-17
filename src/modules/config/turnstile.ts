import { z } from "zod";

import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

export const TURNSTILE_GROUP = "turnstile";

export const turnstileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  siteKey: z.string().optional(),
  secretKey: z.string().optional(),
});
export type TurnstileConfigInput = z.infer<typeof turnstileConfigSchema>;

export type ResolvedTurnstileConfig = {
  enabled: boolean;
  siteKey?: string;
  secretKey?: string;
};

export type TurnstileAdminView = {
  enabled: boolean;
  siteKey?: string;
  secretKeySet: boolean;
  hasDbOverride: boolean;
  envDefaults: {
    enabled: boolean;
    siteKey?: string;
    secretKeySet: boolean;
  };
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function getTurnstileConfig(): Promise<ResolvedTurnstileConfig> {
  const env = getEnv();
  const stored = (await getStoredGroup<TurnstileConfigInput>(TURNSTILE_GROUP)) ?? {};

  return {
    enabled: stored.enabled ?? env.TURNSTILE_ENABLED,
    siteKey: nonEmpty(stored.siteKey) ?? nonEmpty(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
    secretKey: nonEmpty(stored.secretKey) ?? nonEmpty(env.TURNSTILE_SECRET_KEY),
  };
}

export async function getTurnstileAdminView(): Promise<TurnstileAdminView> {
  const env = getEnv();
  const [effective, stored] = await Promise.all([
    getTurnstileConfig(),
    getStoredGroup<TurnstileConfigInput>(TURNSTILE_GROUP),
  ]);

  return {
    enabled: effective.enabled,
    siteKey: effective.siteKey,
    secretKeySet: Boolean(effective.secretKey),
    hasDbOverride: stored !== null,
    envDefaults: {
      enabled: env.TURNSTILE_ENABLED,
      siteKey: nonEmpty(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
      secretKeySet: Boolean(nonEmpty(env.TURNSTILE_SECRET_KEY)),
    },
  };
}

export async function saveTurnstileConfig(input: TurnstileConfigInput): Promise<void> {
  const env = getEnv();
  const existing = (await getStoredGroup<TurnstileConfigInput>(TURNSTILE_GROUP)) ?? {};
  const next: TurnstileConfigInput = {};

  if (input.enabled !== undefined) {
    next.enabled = input.enabled;
  } else if (existing.enabled !== undefined) {
    next.enabled = existing.enabled;
  }

  if (input.siteKey === undefined) {
    const existingSiteKey = nonEmpty(existing.siteKey);
    if (existingSiteKey) next.siteKey = existingSiteKey;
  } else {
    const siteKey = nonEmpty(input.siteKey);
    if (siteKey) next.siteKey = siteKey;
  }

  const secretKey = nonEmpty(input.secretKey);
  if (secretKey) {
    next.secretKey = secretKey;
  } else {
    const existingSecretKey = nonEmpty(existing.secretKey);
    if (existingSecretKey) next.secretKey = existingSecretKey;
  }

  const effective = {
    enabled: next.enabled ?? env.TURNSTILE_ENABLED,
    siteKey: next.siteKey ?? nonEmpty(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
    secretKey: next.secretKey ?? nonEmpty(env.TURNSTILE_SECRET_KEY),
  };
  if (effective.enabled && (!effective.siteKey || !effective.secretKey)) {
    throw new ApiError(400, "turnstileKeysRequired");
  }

  await setStoredGroup<TurnstileConfigInput>(TURNSTILE_GROUP, next);
}

export async function clearTurnstileConfig(): Promise<void> {
  await deleteStoredGroup(TURNSTILE_GROUP);
}
