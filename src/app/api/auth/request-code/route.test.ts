import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  rateLimit: vi.fn(),
  requestLoginCode: vi.fn(),
  resolveLocale: vi.fn(),
  assertTurnstile: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/auth/login-code", () => ({ requestLoginCode: mocks.requestLoginCode }));
vi.mock("@/modules/i18n/server", () => ({ resolveLocale: mocks.resolveLocale }));
vi.mock("@/modules/security/turnstile", () => ({ assertTurnstile: mocks.assertTurnstile }));

import { ApiError } from "@/lib/api";

import { POST } from "./route";

const env = {
  NODE_ENV: "test",
  REQUEST_JSON_MAX_BYTES: 65_536,
  REQUEST_CODE_IP_RATE_MAX: 20,
  REQUEST_CODE_EMAIL_IP_RATE_MAX: 5,
  REQUEST_CODE_UNRESOLVED_RATE_MAX: 100,
  REQUEST_CODE_RATE_WINDOW_MS: 3_600_000,
  TRUSTED_PROXY_HEADER: "x-forwarded-for",
  TRUSTED_PROXY_HOPS: 1,
  SESSION_SECRET: "test-secret-that-is-long-enough-for-hmac",
} as const;

function request(body: unknown, headers: HeadersInit = {}) {
  return new NextRequest("http://localhost/api/auth/request-code", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("request-code route S4 ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue(env);
    mocks.rateLimit.mockReturnValue(true);
    mocks.resolveLocale.mockResolvedValue("zh");
    mocks.assertTurnstile.mockResolvedValue(undefined);
    mocks.requestLoginCode.mockResolvedValue({ suppressed: false, codeId: "code-1" });
  });

  it("applies the IP primary gate before parsing the body", async () => {
    mocks.rateLimit.mockReturnValue(false);

    const response = await POST(request("{not-json", { "x-forwarded-for": "198.51.100.10" }));

    expect(response.status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("request-code-ip:198.51.100.10", 20, 3_600_000);
    expect(mocks.assertTurnstile).not.toHaveBeenCalled();
    expect(mocks.requestLoginCode).not.toHaveBeenCalled();
  });

  it("normalizes email before requestLoginCode and preserves Turnstile", async () => {
    const response = await POST(
      request(
        { email: " Fan@Example.com ", turnstileToken: "token" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.assertTurnstile).toHaveBeenCalledWith("token", "198.51.100.10");
    expect(mocks.requestLoginCode).toHaveBeenCalledWith(
      "fan@example.com",
      expect.objectContaining({
        identity: { kind: "ip", value: "198.51.100.10" },
        ip: "198.51.100.10",
        locale: "zh",
      }),
    );
  });

  it("rejects overlong raw email before Turnstile or send-budget logic", async () => {
    const response = await POST(
      request(
        { email: `${"a".repeat(513)}@example.com`, turnstileToken: "token" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.assertTurnstile).not.toHaveBeenCalled();
    expect(mocks.requestLoginCode).not.toHaveBeenCalled();
  });

  it("does not enter send-budget logic when Turnstile fails", async () => {
    mocks.assertTurnstile.mockRejectedValue(new ApiError(403, "turnstileFailed"));

    const response = await POST(
      request(
        { email: "fan@example.com", turnstileToken: "bad-token" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.requestLoginCode).not.toHaveBeenCalled();
  });

  it("uses one unresolved emergency bucket when no trusted IP is available", async () => {
    const response = await POST(request({ email: "fan@example.com" }));

    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledWith("request-code-unresolved", 100, 3_600_000);
    expect(mocks.requestLoginCode).toHaveBeenCalledWith(
      "fan@example.com",
      expect.objectContaining({ identity: { kind: "unresolved" }, ip: null }),
    );
  });
});
