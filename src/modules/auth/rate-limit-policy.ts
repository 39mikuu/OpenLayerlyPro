import { z } from "zod";

import type { ClientRateLimitIdentity } from "@/lib/client-rate-limit";
import { CROCKFORD_BASE32_ALPHABET, hmacSha256WithPurpose } from "@/lib/crypto";
import type { Env } from "@/lib/env";

export const LOGIN_CODE_ALPHABETS = {
  "crockford-base32": CROCKFORD_BASE32_ALPHABET,
} as const;

export type LoginCodeAlphabet = keyof typeof LOGIN_CODE_ALPHABETS;

export const RAW_EMAIL_MAX_LENGTH = 512;
export const NORMALIZED_EMAIL_MAX_LENGTH = 254;
export const RAW_LOGIN_CODE_MAX_LENGTH = 128;

export const rawEmailSchema = z.string().min(1).max(RAW_EMAIL_MAX_LENGTH);
export const normalizedEmailSchema = z.string().email().max(NORMALIZED_EMAIL_MAX_LENGTH);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeLoginCode(code: string): string {
  return code.trim().toUpperCase();
}

export function getLoginCodeAlphabet(alphabet: LoginCodeAlphabet): string {
  return LOGIN_CODE_ALPHABETS[alphabet];
}

export function getLoginCodePolicy(env: Env) {
  const alphabet = getLoginCodeAlphabet(env.LOGIN_CODE_ALPHABET);
  return {
    alphabet,
    alphabetName: env.LOGIN_CODE_ALPHABET,
    length: env.LOGIN_CODE_LENGTH,
    pattern: new RegExp(
      `^[${alphabet.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}]{${env.LOGIN_CODE_LENGTH}}$`,
    ),
  };
}

export function validateNormalizedEmail(email: string): string {
  return normalizedEmailSchema.parse(email);
}

export function validateLoginCode(code: string, env: Env): string {
  const policy = getLoginCodePolicy(env);
  return z.string().regex(policy.pattern, "Invalid login code").parse(code);
}

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

export function getVerifyCodeWrongAttemptRateLimits(input: {
  identity: ClientRateLimitIdentity;
  normalizedEmail: string;
  env: Env;
}): RateLimitPolicy[] {
  if (input.identity.kind === "unresolved") {
    return [
      {
        key: "verify-code-unresolved",
        max: input.env.VERIFY_CODE_UNRESOLVED_RATE_MAX,
        windowMs: input.env.VERIFY_CODE_RATE_WINDOW_MS,
      },
    ];
  }

  return [
    {
      key: `verify-code-ip:${input.identity.value}`,
      max: input.env.VERIFY_CODE_IP_RATE_MAX,
      windowMs: input.env.VERIFY_CODE_RATE_WINDOW_MS,
    },
    {
      key: `verify-code-email-ip:${authEmailRateLimitDigest(input.normalizedEmail)}:${input.identity.value}`,
      max: input.env.VERIFY_CODE_EMAIL_IP_RATE_MAX,
      windowMs: input.env.VERIFY_CODE_RATE_WINDOW_MS,
    },
  ];
}
