import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    TRUSTED_PROXY_HEADER: "x-forwarded-for",
    TRUSTED_PROXY_HOPS: "1",
    VERIFY_CODE_IP_RATE_MAX: "2",
    VERIFY_CODE_EMAIL_IP_RATE_MAX: "2",
    VERIFY_CODE_UNRESOLVED_RATE_MAX: "30",
    VERIFY_CODE_RATE_WINDOW_MS: "600000",
  });
});

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  setSessionCookie: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({
  createSession: mocks.createSession,
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("@/modules/i18n/server", () => ({ resolveLocale: mocks.resolveLocale }));

import { getDb } from "@/db";
import { loginCodes } from "@/db/schema";
import { hmacSha256WithPurpose } from "@/lib/crypto";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import { POST } from "./route";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const TEST_CODE = "ABCD1234EFGH5678";
const OTHER_CODE = "ZZZZZZZZZZZZZZZZ";

function request(email: string, code = TEST_CODE, ip?: string) {
  return new NextRequest("http://localhost/api/auth/verify-code", {
    method: "POST",
    body: JSON.stringify({ email, code }),
    headers: {
      "content-type": "application/json",
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
  });
}

describeWithDatabase("verify-code route comparison-budget integration", () => {
  const db = getDb();

  beforeEach(async () => {
    __resetRateLimitForTests();
    vi.clearAllMocks();
    mocks.resolveLocale.mockResolvedValue("en");
    mocks.createSession.mockResolvedValue({
      token: "session-token",
      expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.setSessionCookie.mockResolvedValue(undefined);
    await resetDatabase(db);
  });

  it("requires an available source budget before successful verification", async () => {
    const email = "source-budget@example.com";
    const limitedIp = "198.51.100.44";
    const alternateIp = "198.51.100.45";

    await db.insert(loginCodes).values({
      email,
      codeHash: hmacSha256WithPurpose("auth-login-code", TEST_CODE),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    expect((await POST(request(email, OTHER_CODE, limitedIp))).status).toBe(400);
    expect((await POST(request(email, OTHER_CODE, limitedIp))).status).toBe(400);

    expect((await POST(request(email, TEST_CODE, limitedIp))).status).toBe(429);
    expect(mocks.createSession).not.toHaveBeenCalled();

    expect((await POST(request(email, TEST_CODE, alternateIp))).status).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it("bounds unresolved comparisons before the core lookup", async () => {
    const email = "unresolved-expired@example.com";

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await POST(request(email))).status).toBe(400);
    }
    expect((await POST(request(email))).status).toBe(429);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
