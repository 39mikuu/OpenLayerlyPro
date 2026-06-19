import { describe, expect, it, vi } from "vitest";

import { StripePaymentProvider } from "./stripe";

function provider() {
  const create = vi.fn();
  const retrieve = vi.fn();
  const retrieveSession = vi.fn();
  const constructEvent = vi.fn();
  const instance = new StripePaymentProvider(
    { secretKey: "sk_test_secret", webhookSecret: "whsec_secret" },
    {
      checkout: { sessions: { create, retrieve: retrieveSession } },
      balance: { retrieve },
      webhooks: { constructEvent },
    } as never,
  );
  return { instance, create, retrieve, retrieveSession, constructEvent };
}

describe("Stripe payment provider", () => {
  it("creates a hosted one-time checkout session", async () => {
    const { instance, create } = provider();
    create.mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.test/session",
    });

    await expect(
      instance.createCheckout({
        requestId: "11111111-1111-4111-8111-111111111111",
        amountMinor: 500,
        currency: "usd",
        tierName: "Supporter",
        successUrl: "https://site.test/me/orders?paid=1",
        cancelUrl: "https://site.test/checkout/tier",
      }),
    ).resolves.toEqual({
      redirectUrl: "https://checkout.stripe.test/session",
      providerRef: "cs_test_123",
    });
    expect(create).toHaveBeenCalledWith(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: 500,
              product_data: { name: "Supporter" },
            },
            quantity: 1,
          },
        ],
        metadata: { requestId: "11111111-1111-4111-8111-111111111111" },
        success_url: "https://site.test/me/orders?paid=1",
        cancel_url: "https://site.test/checkout/tier",
      },
      { idempotencyKey: "checkout:11111111-1111-4111-8111-111111111111" },
    );
  });

  it("rejects missing or invalid signatures", async () => {
    const { instance, constructEvent } = provider();
    await expect(instance.parseWebhook("{}", null)).rejects.toMatchObject({
      status: 401,
      code: "stripeSignatureInvalid",
    });
    constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });
    await expect(instance.parseWebhook("{}", "bad")).rejects.toMatchObject({
      status: 401,
      code: "stripeSignatureInvalid",
    });
  });

  it("normalizes paid checkout completion and ignores unpaid or unrelated events", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValueOnce({
      id: "evt_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_paid",
          payment_status: "paid",
          amount_total: 500,
          currency: "USD",
          metadata: { requestId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    });
    await expect(instance.parseWebhook("paid", "sig")).resolves.toEqual({
      type: "paid",
      providerRef: "cs_paid",
      requestId: "11111111-1111-4111-8111-111111111111",
      providerEventId: "evt_paid",
      amountMinor: 500,
      currency: "usd",
    });

    constructEvent.mockReturnValueOnce({
      id: "evt_unpaid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_unpaid",
          payment_status: "unpaid",
          amount_total: 500,
          currency: "usd",
        },
      },
    });
    await expect(instance.parseWebhook("unpaid", "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_unpaid",
    });

    constructEvent.mockReturnValueOnce({
      id: "evt_other",
      type: "customer.created",
      data: { object: {} },
    });
    await expect(instance.parseWebhook("other", "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_other",
    });
  });

  it("normalizes expired checkout sessions for stale request cleanup", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_expired",
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_expired",
          metadata: { requestId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    });

    await expect(instance.parseWebhook("expired", "sig")).resolves.toEqual({
      type: "expired",
      providerRef: "cs_expired",
      requestId: "11111111-1111-4111-8111-111111111111",
      providerEventId: "evt_expired",
    });
  });

  it("tests credentials with the Stripe balance endpoint", async () => {
    const { instance, retrieve } = provider();
    retrieve.mockResolvedValue({ available: [], pending: [] });
    await expect(instance.testConnection()).resolves.toBeUndefined();
    expect(retrieve).toHaveBeenCalledOnce();
  });

  it("reports open, complete, and expired checkout session states", async () => {
    const { instance, retrieveSession } = provider();
    retrieveSession
      .mockResolvedValueOnce({
        id: "cs_open",
        status: "open",
        url: "https://checkout.stripe.test/open",
      })
      .mockResolvedValueOnce({ id: "cs_complete", status: "complete", url: null })
      .mockResolvedValueOnce({ id: "cs_expired", status: "expired", url: null });
    await expect(instance.getCheckoutState("cs_open")).resolves.toEqual({
      status: "open",
      redirectUrl: "https://checkout.stripe.test/open",
    });
    await expect(instance.getCheckoutState("cs_complete")).resolves.toEqual({
      status: "complete",
      redirectUrl: null,
    });
    await expect(instance.getCheckoutState("cs_expired")).resolves.toEqual({
      status: "expired",
      redirectUrl: null,
    });
  });
});
