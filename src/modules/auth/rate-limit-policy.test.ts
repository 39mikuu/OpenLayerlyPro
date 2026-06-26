import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    SESSION_SECRET: "auth-rate-policy-test-secret-that-is-long-enough",
  });
});

import type { Env } from "@/lib/env";

import {
  authEmailRateLimitDigest,
  getLoginCodePolicy,
  normalizeEmail,
  normalizeLoginCode,
  validateLoginCode,
  validateNormalizedEmail,
} from "./rate-limit-policy";

const env = {
  LOGIN_CODE_LENGTH: 16,
  LOGIN_CODE_ALPHABET: "crockford-base32",
  SESSION_SECRET: "auth-rate-policy-test-secret",
} as unknown as Env;

describe("auth rate-limit and login-code policy", () => {
  it("normalizes email before validation", () => {
    expect(validateNormalizedEmail(normalizeEmail(" Fan@Example.com "))).toBe("fan@example.com");
  });

  it("normalizes and validates uppercase Crockford base32 codes", () => {
    const code = normalizeLoginCode(" abcd1234efgh5678 ");
    expect(validateLoginCode(code, env)).toBe("ABCD1234EFGH5678");
    expect(getLoginCodePolicy(env).pattern.test(code)).toBe(true);
  });

  it("rejects ambiguous or wrong-length codes", () => {
    expect(() => validateLoginCode("ABCD1234EFGH567", env)).toThrow();
    expect(() => validateLoginCode("ABCD1234EFGH567O", env)).toThrow();
  });

  it("derives stable keyed email identities without exposing raw email", () => {
    const a = authEmailRateLimitDigest(normalizeEmail(" Fan@Example.com "));
    const b = authEmailRateLimitDigest(normalizeEmail("fan@example.com"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain("fan@example.com");
  });
});
