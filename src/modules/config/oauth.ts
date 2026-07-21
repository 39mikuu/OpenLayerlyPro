import { z } from "zod";

import { ApiError } from "@/lib/api";
import { logger } from "@/lib/logger";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

export type OAuthProviderId = "google" | "github";

export const oauthProviderConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});
export type OAuthProviderConfigInput = z.infer<typeof oauthProviderConfigSchema>;

export type ResolvedOAuthProviderConfig = {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  configured: boolean;
};

export type OAuthProviderAdminView = {
  enabled: boolean;
  clientId?: string;
  configured: boolean;
  clientSecretSet: boolean;
  hasDbOverride: boolean;
};

function groupKey(provider: OAuthProviderId): string {
  return provider === "google" ? "oauth_google" : "oauth_github";
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export async function getOAuthProviderConfig(
  provider: OAuthProviderId,
): Promise<ResolvedOAuthProviderConfig> {
  const stored = (await getStoredGroup<OAuthProviderConfigInput>(groupKey(provider))) ?? {};
  const clientId = nonEmpty(stored.clientId);
  const clientSecret = nonEmpty(stored.clientSecret);
  return {
    enabled: stored.enabled ?? false,
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
  };
}

export async function getOAuthProviderAdminView(
  provider: OAuthProviderId,
): Promise<OAuthProviderAdminView> {
  const [effective, stored] = await Promise.all([
    getOAuthProviderConfig(provider),
    getStoredGroup<OAuthProviderConfigInput>(groupKey(provider)),
  ]);
  return {
    enabled: effective.enabled,
    clientId: effective.clientId,
    configured: effective.configured,
    clientSecretSet: Boolean(effective.clientSecret),
    hasDbOverride: stored !== null,
  };
}

export async function saveOAuthProviderConfig(
  provider: OAuthProviderId,
  input: OAuthProviderConfigInput,
): Promise<void> {
  const key = groupKey(provider);
  const existing = (await getStoredGroup<OAuthProviderConfigInput>(key)) ?? {};
  const next: OAuthProviderConfigInput = {
    enabled: input.enabled ?? existing.enabled ?? false,
    clientId: input.clientId === undefined ? nonEmpty(existing.clientId) : nonEmpty(input.clientId),
    clientSecret: nonEmpty(input.clientSecret) ?? nonEmpty(existing.clientSecret),
  };
  if (next.enabled && (!next.clientId || !next.clientSecret)) {
    throw new ApiError(400, "oauthConfigIncomplete");
  }
  await setStoredGroup<OAuthProviderConfigInput>(key, next);
}

export async function clearOAuthProviderConfig(provider: OAuthProviderId): Promise<void> {
  await deleteStoredGroup(groupKey(provider));
}

export async function isOAuthProviderLoginEnabled(provider: OAuthProviderId): Promise<boolean> {
  // Fail closed: a decrypt/parse failure (e.g. bad CONFIG_ENCRYPTION_KEY rotation or a
  // corrupted app_settings row) must only hide this provider's button — it must never
  // break /login and lock users out of the email-code / Magic Link / admin fallbacks.
  try {
    const config = await getOAuthProviderConfig(provider);
    return config.enabled && config.configured;
  } catch (error) {
    logger.warn("oauth provider login-enabled check failed; hiding button", {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
