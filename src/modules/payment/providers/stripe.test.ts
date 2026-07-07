import { describe, expect, it, vi } from "vitest";

import { StripePaymentProvider } from "./stripe";

type StripeFixtureGeneration = "preBasil" | "postBasil";

function provider() {
  const create = vi.fn();
  const retrieve = vi.fn();
  const retrieveSession = vi.fn();
  const listSessions = vi.fn();
  const createSubscription = vi.fn();
  const updateSubscription = vi.fn();
  const cancelSubscription = vi.fn();
  const retrieveSubscription = vi.fn();
  const listInvoices = vi.fn();
  const retrieveInvoice = vi.fn();
  const listCharges = vi.fn();
  const listInvoicePayments = vi.fn();
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
      subscriptions: {
        update: updateSubscription,
        cancel: cancelSubscription,
        retrieve: retrieveSubscription,
      },
      invoices: { list: listInvoices, retrieve: retrieveInvoice },
      invoicePayments: { list: listInvoicePayments },
      charges: { list: listCharges },
      webhooks: { constructEvent },
    } as never,
  );
  return {
    instance,
    create,
    createSubscription,
    retrieve,
    retrieveSession,
    listSessions,
    updateSubscription,
    cancelSubscription,
    retrieveSubscription,
    listInvoices,
    retrieveInvoice,
    listCharges,
    listInvoicePayments,
    constructEvent,
  };
}

describe("Stripe payment provider", () => {
  function subscriptionWithDateHeader(date: string | undefined) {
    return {
      id: "sub_obs",
      status: "active",
      customer: "cus_obs",
      current_period_end: 1_893_456_000,
      items: { data: [] },
      cancel_at_period_end: false,
      lastResponse: { headers: date === undefined ? {} : { date } },
    };
  }

  function checkoutSessionWithDateHeader(date: string | undefined) {
    return {
      id: "cs_obs",
      status: "expired",
      url: null,
      subscription: null,
      lastResponse: { headers: date === undefined ? {} : { date } },
    };
  }

  function subscriptionInvoiceFixture(generation: StripeFixtureGeneration) {
    if (generation === "preBasil") {
      return {
        id: "in_pre_basil",
        subscription: "sub_pre_basil",
        payment_intent: "pi_pre_basil",
        currency: "USD",
        metadata: {
          app: "openlayerlypro",
          subscriptionId: "33333333-3333-4333-8333-333333333333",
          providerPriceRef: "price_pre_basil",
        },
        lines: {
          data: [
            {
              price: { id: "price_pre_basil" },
              amount: 900,
              period: { start: 1_767_225_600, end: 1_769_904_000 },
            },
            {
              price: { id: "price_other" },
              amount: 100,
              period: { start: 1_767_225_600, end: 1_767_312_000 },
            },
          ],
        },
      };
    }

    return {
      id: "in_post_basil",
      subscription: null,
      payment_intent: null,
      parent: {
        type: "subscription_details",
        quote_details: null,
        subscription_details: {
          subscription: "sub_post_basil",
          metadata: {
            app: "openlayerlypro",
            subscriptionId: "44444444-4444-4444-8444-444444444444",
            providerPriceRef: "price_post_basil",
          },
        },
      },
      payments: {
        data: [
          {
            id: "ip_open",
            status: "open",
            payment: { type: "payment_intent", payment_intent: "pi_open" },
          },
          {
            id: "ip_paid",
            status: "paid",
            payment: { type: "payment_intent", payment_intent: "pi_post_basil" },
          },
        ],
      },
      currency: "USD",
      metadata: {},
      lines: {
        data: [
          {
            price: null,
            pricing: {
              type: "price_details",
              price_details: { price: "price_post_basil" },
            },
            amount: 1200,
            period: { start: 1_767_225_600, end: 1_769_904_000 },
          },
        ],
      },
    };
  }

  function postBasilSubscriptionFixture(eventType: string) {
    return {
      id: `evt_${eventType.replaceAll(".", "_")}`,
      created: 1_767_225_600,
      type: eventType,
      data: {
        object: {
          id: "sub_items_webhook",
          status: "active",
          customer: "cus_items_webhook",
          current_period_end: null,
          cancel_at_period_end: false,
          metadata: { subscriptionId: "88888888-8888-4888-8888-888888888888" },
          items: {
            data: [
              { id: "si_short", current_period_end: 1_893_456_000 },
              { id: "si_long", current_period_end: 1_896_048_000 },
            ],
          },
        },
      },
    };
  }

  it("derives retrieveSubscription observedAt from the provider Date header", async () => {
    const { instance, retrieveSubscription } = provider();
    retrieveSubscription.mockResolvedValue(
      subscriptionWithDateHeader("Tue, 20 Jan 2026 00:00:00 GMT"),
    );

    const result = await instance.retrieveSubscription("sub_obs");

    expect(result.observedAt).toEqual(new Date("2026-01-20T00:00:00.000Z"));
  });

  it("returns null observedAt when the provider omits the Date header (fail closed)", async () => {
    const { instance, retrieveSubscription } = provider();
    retrieveSubscription.mockResolvedValue(subscriptionWithDateHeader(undefined));

    const result = await instance.retrieveSubscription("sub_obs");

    expect(result.observedAt).toBeNull();
  });

  it("returns null observedAt when the provider Date header is unparseable", async () => {
    const { instance, retrieveSubscription } = provider();
    retrieveSubscription.mockResolvedValue(subscriptionWithDateHeader("not-a-real-date"));

    const result = await instance.retrieveSubscription("sub_obs");

    expect(result.observedAt).toBeNull();
  });

  it("derives getSubscriptionCheckoutState observedAt from the provider Date header", async () => {
    const { instance, retrieveSession } = provider();
    retrieveSession.mockResolvedValue(
      checkoutSessionWithDateHeader("Tue, 20 Jan 2026 00:00:00 GMT"),
    );

    const result = await instance.getSubscriptionCheckoutState("cs_obs");

    expect(result.observedAt).toEqual(new Date("2026-01-20T00:00:00.000Z"));
  });

  it("returns null checkout observedAt when the provider omits the Date header", async () => {
    const { instance, retrieveSession } = provider();
    retrieveSession.mockResolvedValue(checkoutSessionWithDateHeader(undefined));

    const result = await instance.getSubscriptionCheckoutState("cs_obs");

    expect(result.observedAt).toBeNull();
  });

  it("returns null checkout observedAt when the provider Date header is unparseable", async () => {
    const { instance, retrieveSession } = provider();
    retrieveSession.mockResolvedValue(checkoutSessionWithDateHeader("not-a-real-date"));

    const result = await instance.getSubscriptionCheckoutState("cs_obs");

    expect(result.observedAt).toBeNull();
  });

  it("derives subscription currentPeriodEndsAt from basil subscription items", async () => {
    const { instance, retrieveSubscription } = provider();
    retrieveSubscription.mockResolvedValue({
      id: "sub_items",
      status: "active",
      customer: "cus_items",
      current_period_end: null,
      cancel_at_period_end: false,
      items: {
        data: [
          { id: "si_short", current_period_end: 1_893_456_000 },
          { id: "si_long", current_period_end: 1_896_048_000 },
        ],
      },
      lastResponse: { headers: {} },
    });

    const result = await instance.retrieveSubscription("sub_items");

    expect(result.currentPeriodEndsAt).toEqual(new Date(1_896_048_000 * 1000));
  });

  it.each(["customer.subscription.created", "customer.subscription.updated"] as const)(
    "normalizes post-basil %s current period from subscription items",
    async (eventType) => {
      const { instance, constructEvent } = provider();
      constructEvent.mockReturnValue(postBasilSubscriptionFixture(eventType));

      await expect(instance.parseWebhook(Buffer.from(eventType), "sig")).resolves.toMatchObject({
        type: "subscription_activated",
        localSubscriptionId: "88888888-8888-4888-8888-888888888888",
        providerSubscriptionRef: "sub_items_webhook",
        providerCustomerRef: "cus_items_webhook",
        currentPeriodEndsAt: new Date(1_896_048_000 * 1000),
        cancelAtPeriodEnd: false,
      });
    },
  );

  it("keeps null subscription currentPeriodEndsAt when neither shape has a period", async () => {
    const { instance, retrieveSubscription } = provider();
    retrieveSubscription.mockResolvedValue({
      id: "sub_without_period",
      status: "active",
      customer: "cus_without_period",
      current_period_end: null,
      cancel_at_period_end: false,
      items: { data: [] },
      lastResponse: { headers: {} },
    });

    const result = await instance.retrieveSubscription("sub_without_period");

    expect(result.currentPeriodEndsAt).toBeNull();
  });

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
      providerCreatedAt: new Date(0),
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
      providerCreatedAt: new Date(0),
    });

    constructEvent.mockReturnValueOnce({
      id: "evt_other",
      type: "customer.created",
      data: { object: {} },
    });
    await expect(instance.parseWebhook(Buffer.from("other"), "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_other",
      providerCreatedAt: new Date(0),
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
      providerCreatedAt: new Date(0),
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
            invoice: "in_refunded",
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
      providerInvoiceRef: "in_refunded",
      providerEventId: "evt_refund_full",
      providerCreatedAt: new Date(0),
    });
    await expect(instance.parseWebhook(Buffer.from("partial"), "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_refund_partial",
      providerCreatedAt: new Date(0),
    });
    await expect(instance.parseWebhook(Buffer.from("legacy"), "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_refund_legacy",
      providerCreatedAt: new Date(0),
    });
  });

  it("normalizes disputes separately and ignores disputes without PaymentIntents", async () => {
    const { instance, constructEvent } = provider();
    constructEvent
      .mockReturnValueOnce({
        id: "evt_dispute",
        type: "charge.dispute.created",
        data: { object: { payment_intent: { id: "pi_disputed" }, invoice: "in_disputed" } },
      })
      .mockReturnValueOnce({
        id: "evt_dispute_legacy",
        type: "charge.dispute.created",
        data: { object: { payment_intent: null } },
      });

    await expect(instance.parseWebhook(Buffer.from("dispute"), "sig")).resolves.toEqual({
      type: "disputed",
      paymentRef: "pi_disputed",
      providerInvoiceRef: "in_disputed",
      providerEventId: "evt_dispute",
      providerCreatedAt: new Date(0),
    });
    await expect(instance.parseWebhook(Buffer.from("legacy"), "sig")).resolves.toEqual({
      type: "ignored",
      providerEventId: "evt_dispute_legacy",
      providerCreatedAt: new Date(0),
    });
  });

  it("normalizes post-basil refunds when charge.invoice is null", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_refund_post_basil",
      type: "charge.refunded",
      data: {
        object: {
          refunded: true,
          amount: 500,
          amount_refunded: 500,
          payment_intent: "pi_refunded_post_basil",
          invoice: null,
        },
      },
    });

    await expect(instance.parseWebhook(Buffer.from("refund-post-basil"), "sig")).resolves.toEqual({
      type: "refunded",
      paymentRef: "pi_refunded_post_basil",
      providerInvoiceRef: undefined,
      providerEventId: "evt_refund_post_basil",
      providerCreatedAt: new Date(0),
    });
  });

  it("normalizes post-basil disputes when charge.invoice is null", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_dispute_post_basil",
      type: "charge.dispute.created",
      data: { object: { payment_intent: "pi_disputed_post_basil", invoice: null } },
    });

    await expect(instance.parseWebhook(Buffer.from("dispute-post-basil"), "sig")).resolves.toEqual({
      type: "disputed",
      paymentRef: "pi_disputed_post_basil",
      providerInvoiceRef: undefined,
      providerEventId: "evt_dispute_post_basil",
      providerCreatedAt: new Date(0),
    });
  });

  it("creates a subscription checkout with a stable local idempotency key", async () => {
    const { instance, create } = provider();
    create.mockResolvedValue({
      id: "cs_sub",
      url: "https://checkout.stripe.test/sub",
    });

    await expect(
      instance.createSubscriptionCheckout({
        subscriptionId: "33333333-3333-4333-8333-333333333333",
        priceRef: "price_recurring",
        providerPriceRef: "price_recurring",
        successUrl: "https://site.test/me?subscribed=1",
        cancelUrl: "https://site.test/checkout/tier",
      }),
    ).resolves.toEqual({
      redirectUrl: "https://checkout.stripe.test/sub",
      providerCheckoutRef: "cs_sub",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_recurring", quantity: 1 }],
        metadata: {
          subscriptionId: "33333333-3333-4333-8333-333333333333",
          providerPriceRef: "price_recurring",
          app: "openlayerlypro",
        },
      }),
      { idempotencyKey: "subscription-checkout:33333333-3333-4333-8333-333333333333" },
    );
  });

  it.each(["preBasil", "postBasil"] as const)(
    "normalizes %s subscription invoice renewal payloads",
    async (generation) => {
      const { instance, constructEvent } = provider();
      constructEvent.mockReturnValue({
        id: `evt_invoice_${generation}`,
        created: 1_767_225_600,
        type: "invoice.paid",
        data: { object: subscriptionInvoiceFixture(generation) },
      });

      const expected =
        generation === "preBasil"
          ? {
              localSubscriptionId: "33333333-3333-4333-8333-333333333333",
              providerSubscriptionRef: "sub_pre_basil",
              providerInvoiceRef: "in_pre_basil",
              providerPaymentRef: "pi_pre_basil",
              providerPriceRef: "price_pre_basil",
              amountMinor: 900,
            }
          : {
              localSubscriptionId: "44444444-4444-4444-8444-444444444444",
              providerSubscriptionRef: "sub_post_basil",
              providerInvoiceRef: "in_post_basil",
              providerPaymentRef: "pi_post_basil",
              providerPriceRef: "price_post_basil",
              amountMinor: 1200,
            };

      await expect(
        instance.parseWebhook(Buffer.from(`invoice-${generation}`), "sig"),
      ).resolves.toMatchObject({
        type: "subscription_renewed",
        localSubscriptionId: expected.localSubscriptionId,
        appOwned: true,
        providerSubscriptionRef: expected.providerSubscriptionRef,
        providerInvoiceRef: expected.providerInvoiceRef,
        providerPaymentRef: expected.providerPaymentRef,
        providerPriceRef: expected.providerPriceRef,
        lines: [
          expect.objectContaining({
            providerPriceRef: expected.providerPriceRef,
            periodStart: new Date(1_767_225_600 * 1000),
            periodEnd: new Date(1_769_904_000 * 1000),
            amountMinor: expected.amountMinor,
          }),
          ...(generation === "preBasil"
            ? [expect.objectContaining({ providerPriceRef: "price_other", amountMinor: 100 })]
            : []),
        ],
        currency: "usd",
      });
    },
  );

  it("normalizes post-basil parent subscription metadata before stale root metadata", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_invoice_basil_metadata_precedence",
      created: 1_767_225_600,
      type: "invoice.paid",
      data: {
        object: {
          ...subscriptionInvoiceFixture("postBasil"),
          id: "in_basil_metadata_precedence",
          parent: {
            type: "subscription_details",
            quote_details: null,
            subscription_details: {
              subscription: "sub_basil_metadata_precedence",
              metadata: {
                app: "openlayerlypro",
                subscriptionId: "real-subscription-id",
                providerPriceRef: "real-price",
              },
            },
          },
          metadata: {
            subscriptionId: "root-should-not-win",
            providerPriceRef: "root-price-should-not-win",
          },
          lines: {
            data: [
              {
                price: null,
                pricing: {
                  type: "price_details",
                  price_details: { price: "real-price" },
                },
                amount: 1200,
                period: { start: 1_767_225_600, end: 1_769_904_000 },
              },
            ],
          },
        },
      },
    });

    await expect(
      instance.parseWebhook(Buffer.from("invoice-basil-metadata"), "sig"),
    ).resolves.toMatchObject({
      type: "subscription_renewed",
      localSubscriptionId: "real-subscription-id",
      providerPriceRef: "real-price",
      appOwned: true,
    });
  });

  it("normalizes post-basil invoice payment intents with nested succeeded objects", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_invoice_basil_nested_pi",
      created: 1_767_225_600,
      type: "invoice.paid",
      data: {
        object: {
          ...subscriptionInvoiceFixture("postBasil"),
          id: "in_basil_nested_pi",
          payment_intent: null,
          payments: {
            data: [
              {
                id: "ip_open",
                status: "open",
                payment: { type: "payment_intent", payment_intent: "pi_open" },
              },
              {
                id: "ip_succeeded",
                status: "open",
                payment: {
                  type: "payment_intent",
                  payment_intent: { id: "pi_succeeded", status: "succeeded" },
                },
              },
            ],
          },
        },
      },
    });

    await expect(
      instance.parseWebhook(Buffer.from("invoice-basil-nested-pi"), "sig"),
    ).resolves.toMatchObject({
      type: "subscription_renewed",
      providerPaymentRef: "pi_succeeded",
    });
  });

  it("normalizes legacy subscription-details invoice metadata before root metadata", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_invoice_legacy_subscription_details",
      created: 1767225600,
      type: "invoice.paid",
      data: {
        object: {
          id: "in_legacy_subscription_details",
          subscription: "sub_legacy_subscription_details",
          payment_intent: "pi_legacy_subscription_details",
          currency: "USD",
          subscription_details: {
            metadata: {
              subscriptionId: "77777777-7777-4777-8777-777777777777",
              providerPriceRef: "price_legacy_details",
            },
          },
          metadata: {
            subscriptionId: "root-should-not-win",
            providerPriceRef: "root-price-should-not-win",
          },
          lines: {
            data: [
              {
                price: { id: "price_legacy_details" },
                amount: 900,
                period: { start: 1767225600, end: 1769904000 },
              },
            ],
          },
        },
      },
    });

    await expect(
      instance.parseWebhook(Buffer.from("invoice-legacy-subscription-details"), "sig"),
    ).resolves.toMatchObject({
      type: "subscription_renewed",
      localSubscriptionId: "77777777-7777-4777-8777-777777777777",
      providerSubscriptionRef: "sub_legacy_subscription_details",
      providerInvoiceRef: "in_legacy_subscription_details",
      providerPaymentRef: "pi_legacy_subscription_details",
      providerPriceRef: "price_legacy_details",
      lines: [
        expect.objectContaining({ providerPriceRef: "price_legacy_details", amountMinor: 900 }),
      ],
      currency: "usd",
    });
  });

  it("normalizes post-basil invoice.payment_failed from parent subscription metadata", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_payment_failed_post_basil",
      created: 1_767_225_600,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_failed_post_basil",
          subscription: null,
          parent: {
            type: "subscription_details",
            quote_details: null,
            subscription_details: {
              subscription: "sub_failed_post_basil",
              metadata: { subscriptionId: "99999999-9999-4999-8999-999999999999" },
            },
          },
          metadata: {},
        },
      },
    });

    await expect(
      instance.parseWebhook(Buffer.from("invoice-payment-failed"), "sig"),
    ).resolves.toMatchObject({
      type: "subscription_payment_failed",
      providerSubscriptionRef: "sub_failed_post_basil",
      localSubscriptionId: "99999999-9999-4999-8999-999999999999",
      providerInvoiceRef: "in_failed_post_basil",
    });
  });

  it("normalizes ambiguous post-basil invoice lines for the application layer to reject by snapshot", async () => {
    const { instance, constructEvent } = provider();
    constructEvent.mockReturnValue({
      id: "evt_invoice_ambiguous",
      type: "invoice.paid",
      data: {
        object: {
          ...subscriptionInvoiceFixture("postBasil"),
          id: "in_ambiguous",
          lines: {
            data: [
              {
                price: null,
                pricing: {
                  type: "price_details",
                  price_details: { price: "price_recurring" },
                },
                amount: 900,
                period: { start: 1_767_225_600, end: 1_769_904_000 },
              },
              {
                price: null,
                pricing: {
                  type: "price_details",
                  price_details: { price: "price_recurring" },
                },
                amount: 900,
                period: { start: 1_769_904_000, end: 1_772_323_200 },
              },
            ],
          },
        },
      },
    });

    await expect(instance.parseWebhook(Buffer.from("invoice"), "sig")).resolves.toMatchObject({
      type: "subscription_renewed",
      lines: [
        expect.objectContaining({ providerPriceRef: "price_recurring", amountMinor: 900 }),
        expect.objectContaining({ providerPriceRef: "price_recurring", amountMinor: 900 }),
      ],
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

  it("resolves subscription invoices from legacy charge invoice mapping", async () => {
    const { instance, listCharges, listInvoicePayments, retrieveInvoice } = provider();
    listCharges.mockResolvedValue({ data: [{ invoice: "in_legacy_refund" }] });
    retrieveInvoice.mockResolvedValue({
      id: "in_legacy_refund",
      subscription: "sub_legacy_refund",
      metadata: { subscriptionId: "55555555-5555-4555-8555-555555555555" },
    });

    await expect(instance.resolveInvoiceByPaymentIntent("pi_legacy_refund")).resolves.toEqual({
      providerInvoiceRef: "in_legacy_refund",
      providerSubscriptionRef: "sub_legacy_refund",
      localSubscriptionId: "55555555-5555-4555-8555-555555555555",
    });
    expect(listInvoicePayments).not.toHaveBeenCalled();
  });

  it("resolves subscription invoices from invoice payments when charge.invoice is null", async () => {
    const { instance, listCharges, listInvoicePayments, retrieveInvoice } = provider();
    listCharges.mockResolvedValue({ data: [{ invoice: null }] });
    listInvoicePayments.mockResolvedValue({ data: [{ invoice: "in_basil_refund" }] });
    retrieveInvoice.mockResolvedValue({
      id: "in_basil_refund",
      parent: {
        type: "subscription_details",
        quote_details: null,
        subscription_details: {
          subscription: "sub_basil_refund",
          metadata: { subscriptionId: "66666666-6666-4666-8666-666666666666" },
        },
      },
      metadata: {},
    });

    await expect(instance.resolveInvoiceByPaymentIntent("pi_basil_refund")).resolves.toEqual({
      providerInvoiceRef: "in_basil_refund",
      providerSubscriptionRef: "sub_basil_refund",
      localSubscriptionId: "66666666-6666-4666-8666-666666666666",
    });
    expect(listCharges).toHaveBeenCalledWith({ payment_intent: "pi_basil_refund", limit: 1 });
    expect(listInvoicePayments).toHaveBeenCalledWith({
      payment: { type: "payment_intent", payment_intent: "pi_basil_refund" },
      limit: 1,
    });
    expect(retrieveInvoice).toHaveBeenCalledWith("in_basil_refund");
  });

  it("returns null when PaymentIntent invoice lookup finds no invoice", async () => {
    const { instance, listCharges, listInvoicePayments, retrieveInvoice } = provider();
    listCharges.mockResolvedValue({ data: [{ invoice: null }] });
    listInvoicePayments.mockResolvedValue({ data: [] });

    await expect(instance.resolveInvoiceByPaymentIntent("pi_missing_invoice")).resolves.toBeNull();
    expect(retrieveInvoice).not.toHaveBeenCalled();
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
