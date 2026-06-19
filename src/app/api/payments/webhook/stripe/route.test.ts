import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  parseWebhook: vi.fn(),
  getPaymentProvider: vi.fn(),
  confirmAutoPayment: vi.fn(),
}));

vi.mock("@/modules/payment/providers", () => ({
  getPaymentProvider: mocks.getPaymentProvider,
}));
vi.mock("@/modules/payment", () => ({
  confirmAutoPayment: mocks.confirmAutoPayment,
}));

import { POST } from "./route";

describe("Stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPaymentProvider.mockResolvedValue({ parseWebhook: mocks.parseWebhook });
  });

  it("passes raw body and signature to the provider and confirms paid events", async () => {
    const event = {
      type: "paid" as const,
      providerRef: "cs_paid",
      providerEventId: "evt_paid",
      amountMinor: 500,
      currency: "usd",
    };
    mocks.parseWebhook.mockResolvedValue(event);
    const request = new Request("http://localhost/api/payments/webhook/stripe", {
      method: "POST",
      headers: { "stripe-signature": "signed" },
      body: '{"raw":true}',
    }) as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mocks.parseWebhook).toHaveBeenCalledWith('{"raw":true}', "signed");
    expect(mocks.confirmAutoPayment).toHaveBeenCalledWith("stripe", event);
  });

  it("returns 401 for missing or forged signatures", async () => {
    mocks.parseWebhook.mockRejectedValue(new ApiError(401, "stripeSignatureInvalid"));
    const request = new Request("http://localhost/api/payments/webhook/stripe", {
      method: "POST",
      body: "{}",
    }) as NextRequest;
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(mocks.confirmAutoPayment).not.toHaveBeenCalled();
  });

  it("returns a retryable server error when Stripe webhook configuration is unavailable", async () => {
    mocks.getPaymentProvider.mockRejectedValue(new ApiError(400, "stripeConfigIncomplete"));
    const response = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        body: "{}",
      }) as NextRequest,
    );
    expect(response.status).toBe(503);
  });
});
