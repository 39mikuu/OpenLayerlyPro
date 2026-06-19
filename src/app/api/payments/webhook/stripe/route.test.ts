import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  parseWebhook: vi.fn(),
  getPaymentProvider: vi.fn(),
  confirmAutoPayment: vi.fn(),
  expireAutoPayment: vi.fn(),
  reverseAutoPayment: vi.fn(),
}));

vi.mock("@/modules/payment/providers", () => ({
  getPaymentProvider: mocks.getPaymentProvider,
}));
vi.mock("@/modules/payment", () => ({
  confirmAutoPayment: mocks.confirmAutoPayment,
  expireAutoPayment: mocks.expireAutoPayment,
  reverseAutoPayment: mocks.reverseAutoPayment,
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
      paymentRef: "pi_paid",
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

  it("cancels pending requests for signed expired-session events", async () => {
    const event = {
      type: "expired" as const,
      providerRef: "cs_expired",
      providerEventId: "evt_expired",
    };
    mocks.parseWebhook.mockResolvedValue(event);

    const response = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        headers: { "stripe-signature": "signed" },
        body: '{"expired":true}',
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(mocks.expireAutoPayment).toHaveBeenCalledWith("stripe", event);
    expect(mocks.confirmAutoPayment).not.toHaveBeenCalled();
  });

  it("routes signed refund and dispute events to automatic reversal", async () => {
    const event = {
      type: "refunded" as const,
      paymentRef: "pi_refunded",
      providerEventId: "evt_refunded",
    };
    mocks.parseWebhook.mockResolvedValue(event);

    const response = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        headers: { "stripe-signature": "signed" },
        body: '{"refund":true}',
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(mocks.reverseAutoPayment).toHaveBeenCalledWith("stripe", event);
    expect(mocks.confirmAutoPayment).not.toHaveBeenCalled();

    const dispute = {
      type: "disputed" as const,
      paymentRef: "pi_disputed",
      providerEventId: "evt_disputed",
    };
    mocks.parseWebhook.mockResolvedValue(dispute);
    const disputeResponse = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        headers: { "stripe-signature": "signed" },
        body: '{"dispute":true}',
      }) as NextRequest,
    );

    expect(disputeResponse.status).toBe(200);
    expect(mocks.reverseAutoPayment).toHaveBeenLastCalledWith("stripe", dispute);
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
