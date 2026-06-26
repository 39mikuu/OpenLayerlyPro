import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  rateLimit: vi.fn(),
  verifyLoginCode: vi.fn(),
  createSession: vi.fn(),
  setSessionCookie: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/auth/login-code", () => ({ verifyLoginCode: mocks.verifyLoginCode }));
vi.mock("@/modules/auth/session", () => ({
  createSession: mocks.createSession,
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("@/modules/i18n/server", () => ({ resolveLocale: mocks.resolveLocale }));

import { ApiError } from "@/lib/api";
import { POST } from "./route";

const env = {
  NODE_ENV: "test",
  REQUEST_JSON_MAX_BYTES: 65_536,
  VERIFY_CODE_IP_RATE_MAX: 30,
  VERIFY_CODE_EMAIL_IP_RATE_MAX: 10,
  VERIFY_CODE_UNRESOLVED_RATE_MAX: 300,
  VERIFY_CODE_RATE_WINDOW_MS: 600_000,
  LOGIN_CODE_LENGTH: 16,
  LOGIN_CODE_ALPHABET: "crockford-base32",
  TRUSTED_PROXY_HEADER: "x-forwarded-for",
  TRUSTED_PROXY_HOPS: 1,
  SESSION_SECRET: "test-secret-that-is-long-enough-for-hmac",
} as const;

function request(body: unknown, headers: HeadersInit = {}) {
  return new NextRequest("http://localhost/api/auth/verify-code", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("verify-code route budgets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue(env);
    mocks.rateLimit.mockReturnValue(true);
    mocks.resolveLocale.mockResolvedValue("zh");
    mocks.verifyLoginCode.mockResolvedValue({
      id: "user-1",
      email: "fan@example.com",
      role: "member",
    });
    mocks.createSession.mockResolvedValue({
      token: "session-token",
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    mocks.setSessionCookie.mockResolvedValue(undefined);
  });

  it("checks only the source budget for a correct code", async () => {
    const response = await POST(
      request(
        { email: " Fan@Example.com ", code: "abcd1234efgh5678" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledWith("verify-code-ip:198.51.100.10", 30, 600_000);
    expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verifyLoginCode.mock.invocationCallOrder[0]!,
    );
    expect(mocks.verifyLoginCode).toHaveBeenCalledWith("fan@example.com", "ABCD1234EFGH5678", "zh");
  });

  it("blocks an exhausted source before code comparison", async () => {
    mocks.rateLimit.mockReturnValue(false);

    const response = await POST(
      request(
        { email: "fan@example.com", code: "ABCD1234EFGH5678" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(429);
    expect(mocks.verifyLoginCode).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("charges email+IP only after an incorrect comparison", async () => {
    mocks.verifyLoginCode.mockRejectedValue(new ApiError(400, "codeIncorrect"));

    const response = await POST(
      request(
        { email: "Fan@Example.com", code: "ABCD1234EFGH5678" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.rateLimit.mock.calls[0][0]).toBe("verify-code-ip:198.51.100.10");
    expect(mocks.rateLimit.mock.calls[1][0]).toContain("verify-code-email-ip:");
    expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verifyLoginCode.mock.invocationCallOrder[0]!,
    );
    expect(mocks.verifyLoginCode.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rateLimit.mock.invocationCallOrder[1]!,
    );
    expect(JSON.stringify(mocks.rateLimit.mock.calls)).not.toContain("Fan@Example.com");
  });

  it("rejects invalid raw input without consuming a budget", async () => {
    const response = await POST(
      request(
        { email: `${"a".repeat(513)}@example.com`, code: "A".repeat(129) },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.verifyLoginCode).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("returns 429 when target-scoped failure accounting is exhausted", async () => {
    mocks.verifyLoginCode.mockRejectedValue(new ApiError(400, "codeExpired"));
    mocks.rateLimit.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const response = await POST(
      request(
        { email: "fan@example.com", code: "ABCD1234EFGH5678" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(429);
    expect(mocks.verifyLoginCode).toHaveBeenCalledOnce();
  });

  it("uses only the unresolved source emergency bucket", async () => {
    mocks.verifyLoginCode.mockRejectedValue(new ApiError(400, "codeIncorrect"));

    const response = await POST(request({ email: "fan@example.com", code: "ABCD1234EFGH5678" }));

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledWith("verify-code-unresolved", 300, 600_000);
    expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verifyLoginCode.mock.invocationCallOrder[0]!,
    );
  });
});
