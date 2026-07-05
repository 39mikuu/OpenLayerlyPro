import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  readJsonWithLimit: vi.fn(),
  requireUser: vi.fn(),
  createPaymentRequest: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readJsonWithLimit: mocks.readJsonWithLimit,
  };
});
vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/payment", () => ({ createPaymentRequest: mocks.createPaymentRequest }));

import { POST } from "./route";

describe("payment request auth-before-body invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1", role: "fan" });
    mocks.readJsonWithLimit.mockResolvedValue({
      tierId: "11111111-1111-4111-8111-111111111111",
    });
    mocks.createPaymentRequest.mockResolvedValue({ id: "request-1" });
  });

  it("returns 401 before reading an unauthenticated oversized member JSON body", async () => {
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(
      new Request("http://localhost/api/payment-requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999999999",
        },
        body: "{",
      }) as NextRequest,
    );

    expect(response.status).toBe(401);
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });
});
