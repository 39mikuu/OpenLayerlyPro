import type { ClientRateLimitIdentity } from "@/lib/client-rate-limit";
import { hmacSha256WithPurpose } from "@/lib/crypto";
import type { Env } from "@/lib/env";

export type { LoginCodeAlphabet } from "@/modules/auth/input-policy";
export {
  CROCKFORD_BASE32_ALPHABET,
  getLoginCodeAlphabet,
  getLoginCodePolicy,
  isLoginCodeComplete,
  LOGIN_CODE_ALPHABETS,
  NORMALIZED_EMAIL_MAX_LENGTH,
  normalizedEmailSchema,
  normalizeEmail,
  normalizeLoginCode,
  RAW_EMAIL_MAX_LENGTH,
  RAW_LOGIN_CODE_MAX_LENGTH,
  rawEmailSchema,
  sanitizeLoginCodeInput,
  validateLoginCode,
  validateNormalizedEmail,
} from "@/modules/auth/input-policy";

export function authEmailRateLimitDigest(normalizedEmail: string): string {
  return hmacSha256WithPurpose("auth-rate-limit-email", normalizedEmail);
}

export type RateLimitPolicy = {
  key: string;
  max: number;
  windowMs: number;
};

export function getAdminLoginRateLimit(
  identity: ClientRateLimitIdentity,
  env: Env,
): RateLimitPolicy {
  if (identity.kind === "ip") {
    return {
      key: `admin-login:${identity.value}`,
      max: env.ADMIN_LOGIN_RATE_MAX,
      windowMs: env.ADMIN_LOGIN_RATE_WINDOW_MS,
    };
  }
  return {
    key: "admin-login-unresolved",
    max: env.ADMIN_LOGIN_UNRESOLVED_RATE_MAX,
    windowMs: env.ADMIN_LOGIN_RATE_WINDOW_MS,
  };
}

export function getRequestCodePrimaryRateLimit(
  identity: ClientRateLimitIdentity,
  env: Env,
): RateLimitPolicy {
  if (identity.kind === "ip") {
    return {
      key: `request-code-ip:${identity.value}`,
      max: env.REQUEST_CODE_IP_RATE_MAX,
      windowMs: env.REQUEST_CODE_RATE_WINDOW_MS,
    };
  }
  return {
    key: "request-code-unresolved",
    max: env.REQUEST_CODE_UNRESOLVED_RATE_MAX,
    windowMs: env.REQUEST_CODE_RATE_WINDOW_MS,
  };
}

export function getRequestCodeEmailIpRateLimit(input: {
  normalizedEmail: string;
  ip: string;
  env: Env;
}): RateLimitPolicy {
  return {
    key: `request-code-email-ip:${authEmailRateLimitDigest(input.normalizedEmail)}:${input.ip}`,
    max: input.env.REQUEST_CODE_EMAIL_IP_RATE_MAX,
    windowMs: input.env.REQUEST_CODE_RATE_WINDOW_MS,
  };
}

/**
 * Hard, target-independent budget for real login-code comparisons.
 *
 * This gate runs before verifyLoginCode. Because its key contains no email,
 * attempts from a remote attacker cannot lock a particular victim account;
 * they only exhaust the attacker's own trusted-IP budget. The unresolved
 * fallback remains a deliberately higher shared emergency bucket.
 */
export function getVerifyCodeCompareRateLimit(input: {
  identity: ClientRateLimitIdentity;
  env: Env;
}): RateLimitPolicy {
  if (input.identity.kind === "unresolved") {
    return {
      key: "verify-code-unresolved",
      max: input.env.VERIFY_CODE_UNRESOLVED_RATE_MAX,
      windowMs: input.env.VERIFY_CODE_RATE_WINDOW_MS,
    };
  }

  return {
    key: `verify-code-ip:${input.identity.value}`,
    max: input.env.VERIFY_CODE_IP_RATE_MAX,
    windowMs: input.env.VERIFY_CODE_RATE_WINDOW_MS,
  };
}

/**
 * Target-scoped failure accounting consumed only after an incorrect/expired
 * result. Before comparison, callers may only read-check whether this bucket
 * is already exhausted; they must never consume it there. The trusted IP in
 * the key prevents failures from one source from locking the target elsewhere.
 * The source hard budget independently bounds all real comparisons.
 */
export function getVerifyCodeWrongAttemptRateLimits(input: {
  identity: ClientRateLimitIdentity;
  normalizedEmail: string;
  env: Env;
}): RateLimitPolicy[] {
  if (input.identity.kind === "unresolved") return [];

  return [
    {
      key: `verify-code-email-ip:${authEmailRateLimitDigest(input.normalizedEmail)}:${input.identity.value}`,
      max: input.env.VERIFY_CODE_EMAIL_IP_RATE_MAX,
      windowMs: input.env.VERIFY_CODE_RATE_WINDOW_MS,
    },
  ];
}
