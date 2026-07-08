import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  readJsonWithLimitOrDefault: vi.fn(),
  requireAdmin: vi.fn(),
  rejectPaymentRequest: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readJsonWithLimitOrDefault: mocks.readJsonWithLimitOrDefault,
  };
});
vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/payment", () => ({ rejectPaymentRequest: mocks.rejectPaymentRequest }));

import { POST } from "./route";

describe("admin payment request rejection auth-before-body invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
    mocks.readJsonWithLimitOrDefault.mockResolvedValue({});
    mocks.rejectPaymentRequest.mockResolvedValue({ id: "request-1" });
  });

  it("passes stable reject reason code and optional details to the payment module", async () => {
    mocks.readJsonWithLimitOrDefault.mockResolvedValue({
      rejectReasonCode: "wrong_amount",
      rejectDetails: "Expected $99.",
    });

    const response = await POST(
      new Request("http://localhost/api/admin/payment-requests/request-1/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rejectReasonCode: "wrong_amount", rejectDetails: "Expected $99." }),
      }) as NextRequest,
      { params: Promise.resolve({ id: "request-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.rejectPaymentRequest).toHaveBeenCalledWith("request-1", "admin-1", {
      rejectReasonCode: "wrong_amount",
      rejectDetails: "Expected $99.",
    });
  });

  it("returns 401 before readJsonWithLimitOrDefault on an unauthenticated request", async () => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(
      new Request("http://localhost/api/admin/payment-requests/request-1/reject", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999999999",
        },
        body: "{",
      }) as NextRequest,
      { params: Promise.resolve({ id: "request-1" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimitOrDefault).not.toHaveBeenCalled();
    expect(mocks.rejectPaymentRequest).not.toHaveBeenCalled();
  });
});
