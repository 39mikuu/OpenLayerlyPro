import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createPaymentRequest: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/payment", () => ({ createPaymentRequest: mocks.createPaymentRequest }));

import { POST } from "./route";

const validBody = {
  tierId: "11111111-1111-4111-8111-111111111111",
  paymentMethodId: "22222222-2222-4222-8222-222222222222",
  proofFileId: "33333333-3333-4333-8333-333333333333",
  note: "paid",
};

describe("payment request bounded JSON route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1", role: "fan" });
    mocks.createPaymentRequest.mockResolvedValue({ id: "request-1" });
  });

  it("keeps normal small-request behavior", async () => {
    const response = await POST(
      new Request("http://localhost/api/payment-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(mocks.createPaymentRequest).toHaveBeenCalledWith({ userId: "user-1", ...validBody });
  });

  it("returns 413 before auth, business service, or database-backed work", async () => {
    const response = await POST(
      new Request("http://localhost/api/payment-requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(getEnv().REQUEST_JSON_MAX_BYTES + 1),
        },
        body: "{}",
      }) as NextRequest,
    );

    expect(response.status).toBe(413);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });

  it("returns a stable 400 for malformed JSON without calling downstream services", async () => {
    const response = await POST(
      new Request("http://localhost/api/payment-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }) as NextRequest,
    );

    expect(response.status).toBe(400);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });

  it("preserves authentication enforcement for a valid bounded request", async () => {
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));
    const response = await POST(
      new Request("http://localhost/api/payment-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }) as NextRequest,
    );

    expect(response.status).toBe(401);
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });
});
