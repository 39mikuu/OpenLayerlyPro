import { createHash, randomBytes } from "crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { oauthIdentities, oauthStates, type User, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { decryptSecret, encryptSecret, hmacSha256WithPurpose, safeEqualHex } from "@/lib/crypto";
import { addMinutes } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { normalizeMagicLinkRedirectPath } from "@/modules/auth/magic-link";
import {
  clearOAuthProviderConfig,
  getOAuthProviderAdminView,
  getOAuthProviderConfig,
  isOAuthProviderLoginEnabled,
  oauthProviderConfigSchema,
  type OAuthProviderId,
  saveOAuthProviderConfig,
} from "@/modules/config/oauth";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import { recordEvent } from "@/modules/system/events";
import { touchLastLogin } from "@/modules/user";

export const OAUTH_STATE_TTL_MINUTES = 10;
const STATE_PURPOSE = "auth.oauth_state:v1";

export const OAUTH_BROWSER_BINDING_COOKIE = "olp_oauth_bind";
export type OAuthStartResult = { authorizationUrl: string; browserBinding: string };
export type OAuthCallbackSuccess = {
  user: User;
  redirectPath: string | null;
};

export type OAuthProfile = {
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
};

function requireActiveConfig(provider: OAuthProviderId) {
  return getOAuthProviderConfig(provider).then((config) => {
    if (!config.enabled || !config.configured || !config.clientId || !config.clientSecret) {
      throw new ApiError(503, "oauthNotConfigured");
    }
    return config as {
      enabled: true;
      clientId: string;
      clientSecret: string;
      configured: true;
    };
  });
}

function callbackPath(provider: OAuthProviderId): string {
  return `/api/auth/oauth/${provider}/callback`;
}

export function buildOAuthCallbackUrl(provider: OAuthProviderId): string {
  return buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), callbackPath(provider));
}

function hashState(state: string): string {
  return hmacSha256WithPurpose(STATE_PURPOSE, state);
}

function pkceChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function beginOAuthLogin(
  provider: OAuthProviderId,
  meta?: {
    redirectPath?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<OAuthStartResult> {
  const config = await requireActiveConfig(provider);
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  // Browser-binding nonce: returned to the caller to set as an httpOnly cookie, stored
  // here only as an HMAC. The callback must present the matching cookie, tying the flow
  // to the browser that started it (defeats login CSRF / session swapping).
  const browserBinding = randomBytes(32).toString("base64url");
  const redirectPath = normalizeMagicLinkRedirectPath(meta?.redirectPath);

  await getDb()
    .insert(oauthStates)
    .values({
      provider,
      stateHash: hashState(state),
      browserBindingHash: hashState(browserBinding),
      codeVerifierEncrypted: encryptSecret(codeVerifier),
      redirectPath,
      expiresAt: addMinutes(new Date(), OAUTH_STATE_TTL_MINUTES),
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

  const callbackUrl = buildOAuthCallbackUrl(provider);
  const url = new URL(
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://github.com/login/oauth/authorize",
  );
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkceChallengeS256(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (provider === "google") {
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
  } else {
    url.searchParams.set("scope", "read:user user:email");
  }

  return { authorizationUrl: url.toString(), browserBinding };
}

async function consumeOAuthState(
  provider: OAuthProviderId,
  state: string,
  browserBinding: string | null,
): Promise<{ codeVerifier: string; redirectPath: string | null }> {
  const stateHash = hashState(state);
  const db = getDb();
  const [consumed] = await db
    .update(oauthStates)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(oauthStates.stateHash, stateHash),
        eq(oauthStates.provider, provider),
        isNull(oauthStates.consumedAt),
        gt(oauthStates.expiresAt, sql<Date>`now()`),
      ),
    )
    .returning({
      codeVerifierEncrypted: oauthStates.codeVerifierEncrypted,
      redirectPath: oauthStates.redirectPath,
      browserBindingHash: oauthStates.browserBindingHash,
    });

  if (!consumed) {
    await recordEvent("oauth_login_rejected", { provider, reason: "invalid_state" });
    throw new ApiError(400, "oauthInvalidState");
  }

  // Bind the flow to the initiating browser: the callback must present the cookie nonce
  // whose HMAC matches the one stored at start. A mismatch/missing cookie means this
  // callback was replayed in a different browser (login CSRF / session swapping).
  // Compared after the atomic consume so a failed attempt still burns the single-use row.
  if (consumed.browserBindingHash) {
    const presentedHash = browserBinding ? hashState(browserBinding) : "";
    if (!safeEqualHex(presentedHash, consumed.browserBindingHash)) {
      await recordEvent("oauth_login_rejected", { provider, reason: "browser_binding_mismatch" });
      throw new ApiError(400, "oauthInvalidState");
    }
  }

  let codeVerifier: string;
  try {
    codeVerifier = decryptSecret(consumed.codeVerifierEncrypted);
  } catch {
    await recordEvent("oauth_login_rejected", { provider, reason: "state_decrypt_failed" });
    throw new ApiError(400, "oauthInvalidState");
  }
  return {
    codeVerifier,
    redirectPath: normalizeMagicLinkRedirectPath(consumed.redirectPath),
  };
}

async function exchangeCode(input: {
  provider: OAuthProviderId;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const redirectUri = buildOAuthCallbackUrl(input.provider);
  if (input.provider === "google") {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: input.codeVerifier,
      }),
    });
    if (!res.ok) {
      logger.warn("OAuth token exchange failed", { provider: "google", status: res.status });
      throw new ApiError(502, "oauthProviderError");
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new ApiError(502, "oauthProviderError");
    return body.access_token;
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: input.codeVerifier,
    }),
  });
  if (!res.ok) {
    logger.warn("OAuth token exchange failed", { provider: "github", status: res.status });
    throw new ApiError(502, "oauthProviderError");
  }
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    logger.warn("OAuth token exchange missing access_token", { provider: "github" });
    throw new ApiError(502, "oauthProviderError");
  }
  return body.access_token;
}

export async function fetchOAuthProfile(
  provider: OAuthProviderId,
  accessToken: string,
): Promise<OAuthProfile> {
  if (provider === "google") {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new ApiError(502, "oauthProviderError");
    const body = (await res.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    if (!body.sub) throw new ApiError(502, "oauthProviderError");
    return {
      providerAccountId: body.sub,
      email: body.email?.trim().toLowerCase() ?? null,
      emailVerified: body.email_verified === true,
      displayName: body.name?.trim() || null,
    };
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenLayerlyPro",
    },
  });
  if (!userRes.ok) throw new ApiError(502, "oauthProviderError");
  const userBody = (await userRes.json()) as {
    id?: number | string;
    name?: string;
    login?: string;
  };
  if (userBody.id === undefined || userBody.id === null)
    throw new ApiError(502, "oauthProviderError");

  const emailsRes = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenLayerlyPro",
    },
  });
  if (!emailsRes.ok) throw new ApiError(502, "oauthProviderError");
  const emails = (await emailsRes.json()) as Array<{
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }>;
  const verified = emails.filter((row) => row.verified && row.email);
  const primary = verified.find((row) => row.primary) ?? verified[0];
  return {
    providerAccountId: String(userBody.id),
    email: primary?.email?.trim().toLowerCase() ?? null,
    emailVerified: Boolean(primary?.email),
    displayName: userBody.name?.trim() || userBody.login?.trim() || null,
  };
}

async function resolveUserFromProfile(
  provider: OAuthProviderId,
  profile: OAuthProfile,
): Promise<User> {
  const db = getDb();

  const [identity] = await db
    .select()
    .from(oauthIdentities)
    .where(
      and(
        eq(oauthIdentities.provider, provider),
        eq(oauthIdentities.providerAccountId, profile.providerAccountId),
      ),
    )
    .limit(1);

  if (identity) {
    const [user] = await db.select().from(users).where(eq(users.id, identity.userId)).limit(1);
    if (!user) {
      await recordEvent("oauth_login_rejected", { provider, reason: "identity_user_missing" });
      throw new ApiError(400, "oauthBindFailed");
    }
    // Identity precedence: do not rebind user email when provider email changes.
    return user;
  }

  if (!profile.emailVerified || !profile.email) {
    await recordEvent("oauth_login_rejected", { provider, reason: "email_unverified" });
    throw new ApiError(400, "oauthEmailUnverified");
  }

  const emailNorm = profile.email.trim().toLowerCase();

  // Fence user creation + identity bind in a single transaction. If the identity
  // insert loses a concurrent first-link race (unique violation on
  // (provider, provider_account_id)), the whole transaction rolls back — a user row
  // created in this tx is never committed, so no other request can observe or act on
  // an orphan, and there is no compensating delete that could cascade-remove a
  // legitimately-in-use user.
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.email, emailNorm)).limit(1);

      let user: User;
      let createdNewUser = false;
      if (existing) {
        user = existing;
      } else {
        const [created] = await tx
          .insert(users)
          .values({ email: emailNorm, role: "member" })
          .onConflictDoNothing({ target: users.email })
          .returning();
        if (created) {
          user = created;
          createdNewUser = true;
        } else {
          const [after] = await tx.select().from(users).where(eq(users.email, emailNorm)).limit(1);
          if (!after) throw new ApiError(500, "userCreateFailed");
          user = after;
        }
      }

      // Throws on unique violation → aborts and rolls back this transaction.
      await tx.insert(oauthIdentities).values({
        provider,
        providerAccountId: profile.providerAccountId,
        userId: user.id,
        emailAtLink: profile.email,
      });

      if (createdNewUser && profile.displayName) {
        await tx
          .update(users)
          .set({ displayName: profile.displayName, updatedAt: new Date() })
          .where(and(eq(users.id, user.id), isNull(users.displayName)));
      }

      return user;
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // The identity insert failed inside the transaction (concurrent first-link).
    // Identity-first precedence: whoever now owns this provider account is the user;
    // resolve to that winner idempotently rather than failing the login.
    const [again] = await db
      .select()
      .from(oauthIdentities)
      .where(
        and(
          eq(oauthIdentities.provider, provider),
          eq(oauthIdentities.providerAccountId, profile.providerAccountId),
        ),
      )
      .limit(1);
    if (!again) {
      await recordEvent("oauth_login_rejected", { provider, reason: "identity_insert_race" });
      throw new ApiError(409, "oauthBindFailed");
    }
    const [winner] = await db.select().from(users).where(eq(users.id, again.userId)).limit(1);
    if (!winner) {
      await recordEvent("oauth_login_rejected", { provider, reason: "identity_user_missing" });
      throw new ApiError(400, "oauthBindFailed");
    }
    return winner;
  }
}

export async function completeOAuthLogin(
  provider: OAuthProviderId,
  input: { code: string; state: string; browserBinding: string | null },
): Promise<OAuthCallbackSuccess> {
  if (!input.code?.trim() || !input.state?.trim()) {
    await recordEvent("oauth_login_rejected", { provider, reason: "missing_code_or_state" });
    throw new ApiError(400, "oauthInvalidCallback");
  }

  const config = await requireActiveConfig(provider);
  const consumed = await consumeOAuthState(provider, input.state, input.browserBinding);
  const accessToken = await exchangeCode({
    provider,
    code: input.code,
    codeVerifier: consumed.codeVerifier,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  const profile = await fetchOAuthProfile(provider, accessToken);
  const user = await resolveUserFromProfile(provider, profile);
  await touchLastLogin(user.id);
  await recordEvent("user_login", { userId: user.id, via: `oauth:${provider}` });
  await recordEvent("oauth_login_succeeded", {
    provider,
    userId: user.id,
    providerAccountDigest: hmacSha256WithPurpose(
      "auth.oauth_account",
      `${provider}:${profile.providerAccountId}`,
    ),
  });

  return {
    user,
    redirectPath: consumed.redirectPath,
  };
}

// Re-export config helpers for route convenience
export {
  clearOAuthProviderConfig,
  getOAuthProviderAdminView,
  getOAuthProviderConfig,
  isOAuthProviderLoginEnabled,
  oauthProviderConfigSchema,
  type OAuthProviderId,
  saveOAuthProviderConfig,
};

// test helpers
export const __test = {
  hashState,
  pkceChallengeS256,
  resolveUserFromProfile,
  safeEqualHex,
};
