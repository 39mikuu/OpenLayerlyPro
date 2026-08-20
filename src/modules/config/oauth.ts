import { z } from "zod";

import { ApiError } from "@/lib/api";
import { logger } from "@/lib/logger";

import { requireExpectedRevision } from "./revision";
import {
  deleteStoredGroup,
  getStoredGroup,
  getStoredGroupSnapshot,
  setStoredGroup,
  type StoredGroupSnapshot,
} from "./store";

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
  revision: number;
  enabled: boolean;
  clientId?: string;
  configured: boolean;
  clientSecretSet: boolean;
  hasDbOverride: boolean;
};

export function oauthProviderGroupKey(provider: OAuthProviderId): string {
  return provider === "google" ? "oauth_google" : "oauth_github";
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function resolveOAuthProviderConfig(stored: OAuthProviderConfigInput): ResolvedOAuthProviderConfig {
  const clientId = nonEmpty(stored.clientId);
  const clientSecret = nonEmpty(stored.clientSecret);
  return {
    enabled: stored.enabled ?? false,
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
  };
}

export async function getOAuthProviderConfig(
  provider: OAuthProviderId,
): Promise<ResolvedOAuthProviderConfig> {
  const stored =
    (await getStoredGroup<OAuthProviderConfigInput>(oauthProviderGroupKey(provider))) ?? {};
  return resolveOAuthProviderConfig(stored);
}

export async function getOAuthProviderAdminView(
  provider: OAuthProviderId,
  prefetched?: StoredGroupSnapshot<OAuthProviderConfigInput>,
): Promise<OAuthProviderAdminView> {
  const snapshot =
    prefetched ??
    (await getStoredGroupSnapshot<OAuthProviderConfigInput>(oauthProviderGroupKey(provider)));
  const stored = snapshot.value;
  const effective = resolveOAuthProviderConfig(stored ?? {});
  return {
    revision: snapshot.revision,
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
  expectedRevision = 0,
): Promise<number> {
  const key = oauthProviderGroupKey(provider);
  const snapshot = await getStoredGroupSnapshot<OAuthProviderConfigInput>(key);
  requireExpectedRevision(snapshot.revision, expectedRevision);
  const existing = snapshot.value ?? {};
  const next: OAuthProviderConfigInput = {
    enabled: input.enabled ?? existing.enabled ?? false,
    clientId: input.clientId === undefined ? nonEmpty(existing.clientId) : nonEmpty(input.clientId),
    clientSecret: nonEmpty(input.clientSecret) ?? nonEmpty(existing.clientSecret),
  };
  if (next.enabled && (!next.clientId || !next.clientSecret)) {
    throw new ApiError(400, "oauthConfigIncomplete");
  }
  return setStoredGroup<OAuthProviderConfigInput>(key, next, expectedRevision);
}

export async function clearOAuthProviderConfig(
  provider: OAuthProviderId,
  expectedRevision = 0,
): Promise<number> {
  return deleteStoredGroup(oauthProviderGroupKey(provider), expectedRevision);
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
