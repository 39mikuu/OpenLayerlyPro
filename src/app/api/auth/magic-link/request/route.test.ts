import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  rateLimit: vi.fn(),
  requestMagicLink: vi.fn(),
  resolveLocale: vi.fn(),
  assertTurnstile: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/auth/magic-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/magic-link")>();
  return {
    ...actual,
    requestMagicLink: mocks.requestMagicLink,
  };
});
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
  return new NextRequest("http://localhost/api/auth/magic-link/request", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("magic-link request route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue(env);
    mocks.rateLimit.mockReturnValue(true);
    mocks.resolveLocale.mockResolvedValue("zh");
    mocks.assertTurnstile.mockResolvedValue(undefined);
    mocks.requestMagicLink.mockResolvedValue({ suppressed: false, tokenId: "token-1" });
  });

  it("applies the shared request-code source gate before parsing the body", async () => {
    mocks.rateLimit.mockReturnValue(false);

    const response = await POST(request("{not-json", { "x-forwarded-for": "198.51.100.10" }));

    expect(response.status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("request-code-ip:198.51.100.10", 20, 3_600_000);
    expect(mocks.assertTurnstile).not.toHaveBeenCalled();
    expect(mocks.requestMagicLink).not.toHaveBeenCalled();
  });

  it("returns the same accepted response for sent and suppressed requests", async () => {
    const sent = await POST(
      request(
        { email: " Fan@Example.com ", turnstileToken: "token" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );
    expect(sent.status).toBe(200);
    await expect(sent.json()).resolves.toEqual({ ok: true, data: { accepted: true } });
    expect(mocks.assertTurnstile).toHaveBeenCalledWith("token", "198.51.100.10");
    expect(mocks.requestMagicLink).toHaveBeenCalledWith(
      "fan@example.com",
      expect.objectContaining({
        identity: { kind: "ip", value: "198.51.100.10" },
        ip: "198.51.100.10",
        locale: "zh",
      }),
    );

    mocks.requestMagicLink.mockResolvedValue({ suppressed: true });
    const suppressed = await POST(
      request(
        { email: "fan@example.com", turnstileToken: "token" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );
    expect(suppressed.status).toBe(200);
    await expect(suppressed.json()).resolves.toEqual({ ok: true, data: { accepted: true } });
  });

  it("passes only allowlisted next paths through to requestMagicLink", async () => {
    await POST(
      request(
        { email: "fan@example.com", next: "/posts/deep-dive?utm=mail" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );
    expect(mocks.requestMagicLink).toHaveBeenCalledWith(
      "fan@example.com",
      expect.objectContaining({ redirectPath: "/posts/deep-dive" }),
    );

    await POST(
      request(
        { email: "fan@example.com", next: "https://evil.example/phish" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );
    expect(mocks.requestMagicLink).toHaveBeenLastCalledWith(
      "fan@example.com",
      expect.objectContaining({ redirectPath: null }),
    );
  });

  it("does not enter send logic when Turnstile fails", async () => {
    mocks.assertTurnstile.mockRejectedValue(new ApiError(403, "turnstileFailed"));

    const response = await POST(
      request(
        { email: "fan@example.com", turnstileToken: "bad-token" },
        { "x-forwarded-for": "198.51.100.10" },
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.requestMagicLink).not.toHaveBeenCalled();
  });

  it("uses the unresolved emergency bucket when no trusted IP is available", async () => {
    const response = await POST(request({ email: "fan@example.com" }));

    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledWith("request-code-unresolved", 100, 3_600_000);
    expect(mocks.requestMagicLink).toHaveBeenCalledWith(
      "fan@example.com",
      expect.objectContaining({ identity: { kind: "unresolved" }, ip: null }),
    );
  });
});
