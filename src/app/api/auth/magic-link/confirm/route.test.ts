import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  rateLimit: vi.fn(),
  consumeMagicLinkToken: vi.fn(),
  createSession: vi.fn(),
  setSessionCookie: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/auth/magic-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/magic-link")>();
  return {
    ...actual,
    consumeMagicLinkToken: mocks.consumeMagicLinkToken,
  };
});
vi.mock("@/modules/auth/session", () => ({
  createSession: mocks.createSession,
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("@/modules/i18n/server", () => ({ resolveLocale: mocks.resolveLocale }));

import { POST } from "./route";

const env = {
  NODE_ENV: "test",
  APP_URL: "https://site.example/base",
  REQUEST_JSON_MAX_BYTES: 65_536,
  VERIFY_CODE_IP_RATE_MAX: 30,
  VERIFY_CODE_UNRESOLVED_RATE_MAX: 300,
  VERIFY_CODE_RATE_WINDOW_MS: 600_000,
  TRUSTED_PROXY_HEADER: "x-forwarded-for",
  TRUSTED_PROXY_HOPS: 1,
} as const;

const TOKEN = "olp_mlk.v1.current.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function request(token: string | null, headers: HeadersInit = {}) {
  const body = new URLSearchParams();
  if (token !== null) body.set("token", token);
  return new NextRequest("https://site.example/base/api/auth/magic-link/confirm", {
    method: "POST",
    body: body.toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "198.51.100.10",
      ...headers,
    },
  });
}

function expectTokenHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

describe("magic-link confirm route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue(env);
    mocks.rateLimit.mockReturnValue(true);
    mocks.resolveLocale.mockResolvedValue("zh");
    mocks.consumeMagicLinkToken.mockResolvedValue({
      status: "consumed",
      user: { id: "user-1", email: "fan@example.com", role: "member" },
      redirectPath: null,
      session: {
        token: "session-token",
        expiresAt: new Date("2026-08-20T00:00:00Z"),
      },
    });
    mocks.setSessionCookie.mockResolvedValue(undefined);
  });

  it("uses the atomically committed session and redirects tokenlessly", async () => {
    const response = await POST(request(TOKEN));

    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toBe("https://site.example/base/me");
    expect(location).not.toContain(TOKEN);
    expectTokenHeaders(response);
    expect(mocks.consumeMagicLinkToken).toHaveBeenCalledWith(TOKEN, {
      locale: "zh",
      ip: "198.51.100.10",
      userAgent: null,
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(
      "session-token",
      new Date("2026-08-20T00:00:00Z"),
    );
  });

  it("honors the stored allowlisted redirect path", async () => {
    mocks.consumeMagicLinkToken.mockResolvedValue({
      status: "consumed",
      user: { id: "user-1", email: "fan@example.com", role: "member" },
      redirectPath: "/posts/deep-dive",
      session: {
        token: "session-token",
        expiresAt: new Date("2026-08-20T00:00:00Z"),
      },
    });

    const response = await POST(request(TOKEN));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://site.example/base/posts/deep-dive");
  });

  it.each(["expired", "replayed", "invalid"] as const)(
    "redirects %s consumption to the tokenless result page without a session",
    async (status) => {
      mocks.consumeMagicLinkToken.mockResolvedValue({ status });

      const response = await POST(request(TOKEN));

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        `https://site.example/base/login/magic/result?status=${status}`,
      );
      expectTokenHeaders(response);
      expect(mocks.setSessionCookie).not.toHaveBeenCalled();
    },
  );

  it("shares the verify-code comparison budget and keeps token headers on 429", async () => {
    mocks.rateLimit.mockReturnValue(false);

    const response = await POST(request(TOKEN));

    expect(response.status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("verify-code-ip:198.51.100.10", 30, 600_000);
    expectTokenHeaders(response);
    expect(mocks.consumeMagicLinkToken).not.toHaveBeenCalled();
  });

  it("rejects a missing token with token headers and no consumption", async () => {
    const response = await POST(request(null));

    expect(response.status).toBe(400);
    expectTokenHeaders(response);
    expect(mocks.consumeMagicLinkToken).not.toHaveBeenCalled();
  });
});
