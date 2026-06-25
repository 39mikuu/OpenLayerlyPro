import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createSubscriptionCheckout: vi.fn(),
  getEnv: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/payment/subscriptions", () => ({
  createSubscriptionCheckout: mocks.createSubscriptionCheckout,
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));

import { POST } from "./route";

describe("subscription checkout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
    mocks.getEnv.mockReturnValue({
      APP_URL: "https://site.example/",
      REQUEST_JSON_MAX_BYTES: 65_536,
    });
    mocks.createSubscriptionCheckout.mockResolvedValue({
      redirectUrl: "https://checkout.stripe.test/subscription",
    });
  });

  it("requires a signed-in user", async () => {
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(
      new Request("http://localhost/api/payments/subscribe", {
        method: "POST",
        body: JSON.stringify({ tierId: "22222222-2222-4222-8222-222222222222" }),
      }) as NextRequest,
    );

    expect(response.status).toBe(401);
    expect(mocks.createSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it("uses server-owned success and cancel URLs", async () => {
    const response = await POST(
      new Request("http://localhost/api/payments/subscribe", {
        method: "POST",
        body: JSON.stringify({ tierId: "22222222-2222-4222-8222-222222222222" }),
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(mocks.createSubscriptionCheckout).toHaveBeenCalledWith({
      userId: "11111111-1111-4111-8111-111111111111",
      tierId: "22222222-2222-4222-8222-222222222222",
      successUrl: "https://site.example/me?subscribed=1",
      cancelUrl: "https://site.example/checkout/22222222-2222-4222-8222-222222222222",
    });
  });

  it("rejects oversized JSON before auth", async () => {
    const response = await POST(
      new Request("http://localhost/api/payments/subscribe", {
        method: "POST",
        headers: { "content-length": "65537" },
        body: JSON.stringify({ tierId: "22222222-2222-4222-8222-222222222222" }),
      }) as NextRequest,
    );

    expect(response.status).toBe(413);
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });
});
