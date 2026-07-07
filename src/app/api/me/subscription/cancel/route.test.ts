import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  cancelMySubscription: vi.fn(),
  getEnv: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/payment/subscriptions", () => ({
  cancelMySubscription: mocks.cancelMySubscription,
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));

import { POST } from "./route";

describe("subscription cancel route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
    mocks.getEnv.mockReturnValue({ REQUEST_JSON_MAX_BYTES: 65_536 });
    mocks.cancelMySubscription.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      cancelAtPeriodEnd: true,
    });
  });

  it("requires a signed-in user", async () => {
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(
      new Request("http://localhost/api/me/subscription/cancel", {
        method: "POST",
        body: JSON.stringify({ subscriptionId: "33333333-3333-4333-8333-333333333333" }),
      }) as NextRequest,
    );

    expect(response.status).toBe(401);
    expect(mocks.cancelMySubscription).not.toHaveBeenCalled();
  });

  it("cancels the current user's subscription at period end", async () => {
    const response = await POST(
      new Request("http://localhost/api/me/subscription/cancel", {
        method: "POST",
        body: JSON.stringify({ subscriptionId: "33333333-3333-4333-8333-333333333333" }),
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(mocks.cancelMySubscription).toHaveBeenCalledWith({
      userId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("rejects oversized JSON after auth", async () => {
    const response = await POST(
      new Request("http://localhost/api/me/subscription/cancel", {
        method: "POST",
        headers: { "content-length": "65537" },
        body: JSON.stringify({ subscriptionId: "33333333-3333-4333-8333-333333333333" }),
      }) as NextRequest,
    );

    expect(response.status).toBe(413);
    expect(mocks.requireUser).toHaveBeenCalledOnce();
  });
});
