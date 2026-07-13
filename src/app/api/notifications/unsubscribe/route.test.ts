import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appUrl: "https://artist.example",
  readBoundedRawBody: vi.fn(),
  readFormDataWithLimit: vi.fn(),
  unsubscribeNotificationToken: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ APP_URL: mocks.appUrl, REQUEST_JSON_MAX_BYTES: 65_536 }),
}));
vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readBoundedRawBody: mocks.readBoundedRawBody,
    readFormDataWithLimit: mocks.readFormDataWithLimit,
  };
});
vi.mock("@/modules/notifications", () => ({
  unsubscribeNotificationToken: mocks.unsubscribeNotificationToken,
}));

import { POST as ONE_CLICK_POST } from "./[token]/route";
import { POST as CONFIRM_POST } from "./route";

function headers(response: Response) {
  return {
    cache: response.headers.get("cache-control"),
    referrer: response.headers.get("referrer-policy"),
    robots: response.headers.get("x-robots-tag"),
  };
}

describe("notification unsubscribe routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appUrl = "https://artist.example";
    mocks.readBoundedRawBody.mockResolvedValue(Buffer.alloc(0));
    mocks.readFormDataWithLimit.mockResolvedValue(new FormData());
    mocks.unsubscribeNotificationToken.mockResolvedValue("success");
  });

  it("one-click POST reads a bounded body, needs no login, and returns no-store noindex headers", async () => {
    const response = await ONE_CLICK_POST(
      new Request("http://localhost/api/notifications/unsubscribe/token-value", {
        method: "POST",
      }) as NextRequest,
      { params: Promise.resolve({ token: "token-value" }) },
    );

    expect(response.status).toBe(204);
    expect(mocks.readBoundedRawBody).toHaveBeenCalledWith(expect.any(Request), 1024);
    expect(mocks.unsubscribeNotificationToken).toHaveBeenCalledWith("token-value");
    expect(headers(response)).toEqual({
      cache: "no-store",
      referrer: "no-referrer",
      robots: "noindex, nofollow",
    });
  });

  it("one-click POST is idempotent for already-disabled tokens", async () => {
    mocks.unsubscribeNotificationToken.mockResolvedValue("already-disabled");

    const response = await ONE_CLICK_POST(
      new Request("http://localhost/api/notifications/unsubscribe/token-value", {
        method: "POST",
      }) as NextRequest,
      { params: Promise.resolve({ token: "token-value" }) },
    );

    expect(response.status).toBe(204);
  });

  it("one-click POST returns compact JSON with an error status for invalid tokens", async () => {
    mocks.unsubscribeNotificationToken.mockResolvedValue("invalid");

    const response = await ONE_CLICK_POST(
      new Request("http://localhost/api/notifications/unsubscribe/token-value", {
        method: "POST",
        headers: { accept: "application/json" },
      }) as NextRequest,
      { params: Promise.resolve({ token: "token-value" }) },
    );

    await expect(response.json()).resolves.toEqual({ ok: false, status: "invalid" });
    expect(response.status).toBe(400);
    expect(headers(response)).toEqual({
      cache: "no-store",
      referrer: "no-referrer",
      robots: "noindex, nofollow",
    });
  });

  it("browser confirmation POST redirects to a tokenless result URL", async () => {
    const form = new FormData();
    form.set("token", "token-value");
    mocks.readFormDataWithLimit.mockResolvedValue(form);

    const response = await CONFIRM_POST(
      new Request("http://localhost/api/notifications/unsubscribe", {
        method: "POST",
      }) as NextRequest,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://artist.example/unsubscribe/notifications/result?status=success",
    );
    expect(response.headers.get("location")).not.toContain("token-value");
    expect(mocks.unsubscribeNotificationToken).toHaveBeenCalledWith("token-value");
  });

  it("browser confirmation redirect keeps an APP_URL path prefix", async () => {
    mocks.appUrl = "https://artist.example/base";
    const form = new FormData();
    form.set("token", "token-value");
    mocks.readFormDataWithLimit.mockResolvedValue(form);
    mocks.unsubscribeNotificationToken.mockResolvedValue("already-disabled");

    const response = await CONFIRM_POST(
      new Request("http://localhost/base/api/notifications/unsubscribe", {
        method: "POST",
      }) as NextRequest,
    );

    expect(response.status).toBe(303);
    // The prefix survives and the status stays a normal query parameter.
    expect(response.headers.get("location")).toBe(
      "https://artist.example/base/unsubscribe/notifications/result?status=already-disabled",
    );
  });
});
