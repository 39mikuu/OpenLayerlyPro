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
  validateLoginCodeChallenge,
  validateNormalizedEmail,
} from "./rate-limit-policy";

const env = {
  LOGIN_CODE_LENGTH: 6,
  LOGIN_CODE_ALPHABET: "decimal",
  SESSION_SECRET: "auth-rate-policy-test-secret",
} as unknown as Env;

describe("auth rate-limit and login-code policy", () => {
  it("normalizes email before validation", () => {
    expect(validateNormalizedEmail(normalizeEmail(" Fan@Example.com "))).toBe("fan@example.com");
  });

  it("normalizes and validates six-digit codes", () => {
    const code = normalizeLoginCode(" 012345 ");
    expect(validateLoginCode(code, env)).toBe("012345");
    expect(getLoginCodePolicy(env).pattern.test(code)).toBe(true);
  });

  it("accepts legacy Crockford candidates during the migration window", () => {
    expect(validateLoginCode("ABCD1234EFGH5678", env)).toBe("ABCD1234EFGH5678");
    expect(validateLoginCode("A".repeat(24), env)).toBe("A".repeat(24));
    expect(validateLoginCode("1".repeat(64), env)).toBe("1".repeat(64));
    expect(getLoginCodePolicy(env).pattern.test("ABCD1234EFGH5678")).toBe(false);
  });

  it("rejects malformed new and legacy candidates", () => {
    expect(() => validateLoginCode("12345", env)).toThrow();
    expect(() => validateLoginCode("12345A", env)).toThrow();
    expect(() => validateLoginCode("ABCD1234EFGH567O", env)).toThrow();
    expect(() => validateLoginCode("A".repeat(65), env)).toThrow();
  });

  it("accepts only unpadded 32-byte base64url challenges", () => {
    expect(validateLoginCodeChallenge("A".repeat(43))).toBe("A".repeat(43));
    expect(() => validateLoginCodeChallenge("A".repeat(42))).toThrow();
    expect(() => validateLoginCodeChallenge(`${"A".repeat(42)}=`)).toThrow();
  });

  it("derives stable keyed email identities without exposing raw email", () => {
    const a = authEmailRateLimitDigest(normalizeEmail(" Fan@Example.com "));
    const b = authEmailRateLimitDigest(normalizeEmail("fan@example.com"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain("fan@example.com");
  });
});
