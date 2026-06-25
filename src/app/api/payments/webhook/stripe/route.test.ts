import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";

const mocks = vi.hoisted(() => ({
  parseWebhook: vi.fn(),
  getPaymentProvider: vi.fn(),
  persistPaymentProviderEvent: vi.fn(),
}));

vi.mock("@/modules/payment/providers", () => ({
  getPaymentProvider: mocks.getPaymentProvider,
}));
vi.mock("@/modules/payment/subscriptions", () => ({
  persistPaymentProviderEvent: mocks.persistPaymentProviderEvent,
}));

import { POST } from "./route";

describe("Stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPaymentProvider.mockResolvedValue({ parseWebhook: mocks.parseWebhook });
  });

  it("passes raw body and signature to the provider and persists paid events", async () => {
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
    expect(mocks.parseWebhook).toHaveBeenCalledWith(Buffer.from('{"raw":true}'), "signed");
    expect(mocks.persistPaymentProviderEvent).toHaveBeenCalledWith("stripe", event);
  });

  it("returns 401 for a missing signature before loading Stripe configuration", async () => {
    const request = new Request("http://localhost/api/payments/webhook/stripe", {
      method: "POST",
      body: "{}",
    }) as NextRequest;
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(mocks.getPaymentProvider).not.toHaveBeenCalled();
    expect(mocks.parseWebhook).not.toHaveBeenCalled();
    expect(mocks.persistPaymentProviderEvent).not.toHaveBeenCalled();
  });

  it("returns 401 for a forged signature", async () => {
    mocks.parseWebhook.mockRejectedValue(new ApiError(401, "stripeSignatureInvalid"));
    const request = new Request("http://localhost/api/payments/webhook/stripe", {
      method: "POST",
      headers: { "stripe-signature": "forged" },
      body: "{}",
    }) as NextRequest;
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(mocks.parseWebhook).toHaveBeenCalledWith(Buffer.from("{}"), "forged");
    expect(mocks.persistPaymentProviderEvent).not.toHaveBeenCalled();
  });

  it("persists signed expired-session events", async () => {
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
    expect(mocks.persistPaymentProviderEvent).toHaveBeenCalledWith("stripe", event);
  });

  it("persists signed refund and dispute events", async () => {
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
    expect(mocks.persistPaymentProviderEvent).toHaveBeenCalledWith("stripe", event);

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
    expect(mocks.persistPaymentProviderEvent).toHaveBeenLastCalledWith("stripe", dispute);
  });

  it("preserves whitespace, newlines, and non-ASCII webhook bytes", async () => {
    mocks.parseWebhook.mockResolvedValue({ type: "ignored", providerEventId: "evt_exact" });
    const rawBody = Buffer.from('{\n  "note": "你好"  \n}', "utf8");

    const response = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        headers: { "stripe-signature": "signed" },
        body: rawBody,
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(mocks.parseWebhook).toHaveBeenCalledWith(Buffer.from(rawBody), "signed");
  });

  it("rejects declared or actual oversized bodies before Stripe or payment persistence", async () => {
    const limit = getEnv().STRIPE_WEBHOOK_MAX_BYTES;
    const declaredResponse = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        headers: {
          "content-length": String(limit + 1),
          "stripe-signature": "signed",
        },
        body: "{}",
      }) as NextRequest,
    );
    expect(declaredResponse.status).toBe(413);
    expect(mocks.getPaymentProvider).not.toHaveBeenCalled();

    const actualResponse = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        headers: {
          "content-length": "1",
          "stripe-signature": "signed",
        },
        body: Buffer.alloc(limit + 1, 97),
      }) as NextRequest,
    );
    expect(actualResponse.status).toBe(413);
    expect(mocks.getPaymentProvider).not.toHaveBeenCalled();
    expect(mocks.parseWebhook).not.toHaveBeenCalled();
    expect(mocks.persistPaymentProviderEvent).not.toHaveBeenCalled();
  });

  it("accepts a webhook exactly at the configured transfer limit", async () => {
    const limit = getEnv().STRIPE_WEBHOOK_MAX_BYTES;
    const rawBody = Buffer.alloc(limit, 32);
    mocks.parseWebhook.mockResolvedValue({ type: "ignored", providerEventId: "evt_boundary" });

    const response = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        headers: {
          "content-length": String(limit),
          "stripe-signature": "signed",
        },
        body: rawBody,
      }) as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(mocks.parseWebhook).toHaveBeenCalledWith(Buffer.from(rawBody), "signed");
  });

  it("returns a retryable server error when Stripe webhook configuration is unavailable", async () => {
    mocks.getPaymentProvider.mockRejectedValue(new ApiError(400, "stripeConfigIncomplete"));
    const response = await POST(
      new Request("http://localhost/api/payments/webhook/stripe", {
        method: "POST",
        headers: { "stripe-signature": "signed" },
        body: "{}",
      }) as NextRequest,
    );
    expect(response.status).toBe(503);
  });
});
