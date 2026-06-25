import { describe, expect, it, vi } from "vitest";

import { StripePaymentProvider } from "./stripe";

function provider() {
  const create = vi.fn();
  const retrieve = vi.fn();
  const retrieveSession = vi.fn();
  const listSessions = vi.fn();
  const constructEvent = vi.fn();
  const instance = new StripePaymentProvider(
    { secretKey: "sk_test_secret", webhookSecret: "whsec_secret" },
    {
      checkout: {
        sessions: {
          create,
          retrieve: retrieveSession,
          list: listSessions,
        },
      },
      balance: { retrieve },
      webhooks: { constructEvent },
    } as never,
  );
  return { instance, create, retrieve, retrieveSession, listSessions, constructEvent };
}

describe("Stripe payment provider", () => {
  it("creates a hosted one-time checkout session with ownership metadata", async () => {
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
        metadata: {
          requestId: "11111111-1111-4111-8111-111111111111",
          app: "openlayerlypro",
        },
        success_url: "https://site.test/me/orders?paid=1",
        cancel_url: "https://site.test/checkout/tier",
      },
      { idempotencyKey: "checkout:11111111-1111-4111-8111-111111111111" },
    );
  });

  it("rejects missing or invalid signatures", async () => {
    const { instance, constructEvent } = provider();
    await expect(instance.parseWebhook(Buffer.from("{}"), null)).rejects.toMatchObject({
      status: 401,
      code: "stripeSignatureInvalid",
    });
    constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });
    await expect(instance.parseWebhook(Buffer.from("{}"), "bad")).rejects.toMatchObject({
      status: 401,
      code: "stripeSignatureInvalid",
    });
  });

  it("passes the exact raw Buffer, including whitespace and non-ASCII bytes, to Stripe", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_exact",
      type: "customer.created",
      data: { object: {} },
    });
    const rawBody = Buffer.from('{\n  "note": "你好"  \n}', "utf8");

    await instance.parseWebhook(rawBody, "sig");

    expect(constructEvent).toHaveBeenCalledWith(rawBody, "sig", "whsec_secret");
    expect(constructEvent.mock.calls[0]?.[0]).toBe(rawBody);
  });

  it("normalizes paid checkout completion with its PaymentIntent", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_paid",
          payment_intent: "pi_paid",
          payment_status: "paid",
          amount_total: 500,
          currency: "USD",
          metadata: { requestId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    });
    await expect(instance.parseWebhook(Buffer.from("paid"), "sig")).resolves.toEqual({
      type: "paid",
      providerRef: "cs_paid",
      paymentRef: "pi_paid",
      requestId: "11111111-1111-4111-8111-111111111111",
      providerEventId: "evt_paid",
      amountMinor: 500,
      currency: "usd",
    });
  });

  it("rejects a paid checkout event without a PaymentIntent", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_invalid_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_invalid_paid",
          payment_intent: null,
          payment_status: "paid",
          amount_total: 500,
          currency: "usd",
        },
      },
    });
    await expect(instance.parseWebhook(Buffer.from("paid"), "sig")).rejects.toMatchObject({
      status: 422,
      code: "stripeEventInvalid",
    });
  });

  it("ignores unpaid or unrelated events", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValueOnce({
      id: "evt_unpaid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_unpaid",
          payment_intent: "pi_unpaid",
          payment_status: "unpaid",
          amount_total: 500,
          currency: "usd",
        },
      },
    });
    await expect(instance.parseWebhook(Buffer.from("unpaid"), "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_unpaid",
    });

    constructEvent.mockReturnValueOnce({
      id: "evt_other",
      type: "customer.created",
      data: { object: {} },
    });
    await expect(instance.parseWebhook(Buffer.from("other"), "sig")).resolves.toEqual({
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

    await expect(instance.parseWebhook(Buffer.from("expired"), "sig")).resolves.toEqual({
      type: "expired",
      providerRef: "cs_expired",
      requestId: "11111111-1111-4111-8111-111111111111",
      providerEventId: "evt_expired",
    });
  });

  it("normalizes only full charge refunds and safely ignores missing PaymentIntents", async () => {
    const { instance, constructEvent } = provider();
    constructEvent
      .mockReturnValueOnce({
        id: "evt_refund_full",
        type: "charge.refunded",
        data: {
          object: {
            refunded: true,
            amount: 500,
            amount_refunded: 500,
            payment_intent: "pi_refunded",
          },
        },
      })
      .mockReturnValueOnce({
        id: "evt_refund_partial",
        type: "charge.refunded",
        data: {
          object: {
            refunded: false,
            amount: 500,
            amount_refunded: 200,
            payment_intent: "pi_partial",
          },
        },
      })
      .mockReturnValueOnce({
        id: "evt_refund_legacy",
        type: "charge.refunded",
        data: {
          object: {
            refunded: true,
            amount: 500,
            amount_refunded: 500,
            payment_intent: null,
          },
        },
      });

    await expect(instance.parseWebhook(Buffer.from("full"), "sig")).resolves.toEqual({
      type: "refunded",
      paymentRef: "pi_refunded",
      providerEventId: "evt_refund_full",
    });
    await expect(instance.parseWebhook(Buffer.from("partial"), "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_refund_partial",
    });
    await expect(instance.parseWebhook(Buffer.from("legacy"), "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_refund_legacy",
    });
  });

  it("normalizes disputes separately and ignores disputes without PaymentIntents", async () => {
    const { instance, constructEvent } = provider();
    constructEvent
      .mockReturnValueOnce({
        id: "evt_dispute",
        type: "charge.dispute.created",
        data: { object: { payment_intent: { id: "pi_disputed" } } },
      })
      .mockReturnValueOnce({
        id: "evt_dispute_legacy",
        type: "charge.dispute.created",
        data: { object: { payment_intent: null } },
      });

    await expect(instance.parseWebhook(Buffer.from("dispute"), "sig")).resolves.toEqual({
      type: "disputed",
      paymentRef: "pi_disputed",
      providerEventId: "evt_dispute",
    });
    await expect(instance.parseWebhook(Buffer.from("legacy"), "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_dispute_legacy",
    });
  });

  it("resolves Checkout Sessions by PaymentIntent and reports ownership", async () => {
    const { instance, listSessions } = provider();
    listSessions
      .mockResolvedValueOnce({
        data: [
          {
            id: "cs_owned",
            metadata: {
              app: "openlayerlypro",
              requestId: "11111111-1111-4111-8111-111111111111",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [{ id: "cs_external", metadata: { app: "another-product" } }],
      })
      .mockResolvedValueOnce({ data: [] });

    await expect(instance.resolveCheckoutByPaymentIntent("pi_owned")).resolves.toEqual({
      providerRef: "cs_owned",
      requestId: "11111111-1111-4111-8111-111111111111",
      owned: true,
    });
    await expect(instance.resolveCheckoutByPaymentIntent("pi_external")).resolves.toEqual({
      providerRef: "cs_external",
      requestId: undefined,
      owned: false,
    });
    await expect(instance.resolveCheckoutByPaymentIntent("pi_missing")).resolves.toBeNull();
    expect(listSessions).toHaveBeenNthCalledWith(1, {
      payment_intent: "pi_owned",
      limit: 1,
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
