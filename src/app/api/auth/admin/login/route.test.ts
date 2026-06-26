import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  rateLimit: vi.fn(),
  assertContentLengthWithinLimit: vi.fn(),
  readJsonWithLimit: vi.fn(),
  adminLogin: vi.fn(),
  createSession: vi.fn(),
  setSessionCookie: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/request-body", () => ({
  assertContentLengthWithinLimit: mocks.assertContentLengthWithinLimit,
  readJsonWithLimit: mocks.readJsonWithLimit,
}));
vi.mock("@/modules/auth/admin-login", () => ({ adminLogin: mocks.adminLogin }));
vi.mock("@/modules/auth/session", () => ({
  createSession: mocks.createSession,
  setSessionCookie: mocks.setSessionCookie,
}));

import { POST } from "./route";

function request(body: string, headers: HeadersInit = {}) {
  return new NextRequest("http://localhost/api/auth/admin/login", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("admin login request ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue({
      NODE_ENV: "test",
      REQUEST_JSON_MAX_BYTES: 65_536,
      ADMIN_LOGIN_RATE_MAX: 10,
      ADMIN_LOGIN_UNRESOLVED_RATE_MAX: 100,
      ADMIN_LOGIN_RATE_WINDOW_MS: 600_000,
      TRUSTED_PROXY_HEADER: "x-forwarded-for",
      TRUSTED_PROXY_HOPS: 1,
    });
    mocks.rateLimit.mockReturnValue(true);
    mocks.readJsonWithLimit.mockResolvedValue({
      email: "admin@example.test",
      password: "secret",
    });
    mocks.adminLogin.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      email: "admin@example.test",
      role: "admin",
    });
    mocks.createSession.mockResolvedValue({
      token: "token",
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    mocks.setSessionCookie.mockResolvedValue(undefined);
  });

  it.each([
    ["oversized", "x".repeat(100), { "content-length": "100" }],
    ["malformed", "{not-json", {}],
  ])(
    "does not parse a %s body after the IP rate limit returns 429",
    async (_name, body, headers) => {
      mocks.rateLimit.mockReturnValue(false);

      const response = await POST(request(body, headers));

      expect(response.status).toBe(429);
      expect(mocks.assertContentLengthWithinLimit).toHaveBeenCalledOnce();
      expect(mocks.rateLimit).toHaveBeenCalledOnce();
      expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
      expect(mocks.adminLogin).not.toHaveBeenCalled();
    },
  );

  it("checks declared length and IP rate limit before parsing a normal request", async () => {
    const response = await POST(
      request('{"email":"admin@example.test","password":"secret"}', {
        "x-forwarded-for": "198.51.100.40",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.assertContentLengthWithinLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rateLimit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readJsonWithLimit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.readJsonWithLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.adminLogin.mock.invocationCallOrder[0]!,
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith("admin-login:198.51.100.40", 10, 600_000);
  });

  it("uses admin-login-unresolved instead of an unknown pseudo-IP", async () => {
    const response = await POST(request('{"email":" admin@example.test ","password":"secret"}'));

    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledWith("admin-login-unresolved", 100, 600_000);
    expect(JSON.stringify(mocks.rateLimit.mock.calls)).not.toContain("unknown");
    expect(mocks.adminLogin).toHaveBeenCalledWith("admin@example.test", "secret");
  });
});
