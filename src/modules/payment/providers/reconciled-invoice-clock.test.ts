import { describe, expect, it, vi } from "vitest";

import { StripePaymentProvider } from "./stripe";

type StripeFixtureGeneration = "preBasil" | "postBasil";

function providerWithInvoice(invoice: Record<string, unknown>) {
  const listInvoices = vi.fn().mockResolvedValue({ data: [invoice] });
  const instance = new StripePaymentProvider(
    { secretKey: "sk_test_secret", webhookSecret: "whsec_secret" },
    {
      checkout: { sessions: {} },
      balance: {},
      subscriptions: {},
      invoices: { list: listInvoices },
      charges: {},
      webhooks: {},
    } as never,
  );
  return { instance, listInvoices };
}

function paidInvoice(
  generation: StripeFixtureGeneration,
  input: { created: number; paidAt?: number | null },
) {
  const base = {
    id: `in_reconcile_${generation}`,
    currency: "usd",
    created: input.created,
    status_transitions: { paid_at: input.paidAt ?? null },
  };

  if (generation === "preBasil") {
    return {
      ...base,
      subscription: "sub_reconcile",
      payment_intent: "pi_reconcile",
      metadata: {
        subscriptionId: "11111111-1111-4111-8111-111111111111",
        providerPriceRef: "price_reconcile",
      },
      lines: {
        data: [
          {
            price: { id: "price_reconcile" },
            amount: 900,
            period: { start: 1_767_225_600, end: 1_769_904_000 },
          },
        ],
      },
    };
  }

  return {
    ...base,
    subscription: null,
    payment_intent: null,
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: {
        subscription: "sub_reconcile",
        metadata: {
          subscriptionId: "11111111-1111-4111-8111-111111111111",
          providerPriceRef: "price_reconcile",
        },
      },
    },
    payments: {
      data: [
        {
          id: "ip_reconcile_paid",
          status: "paid",
          payment: { type: "payment_intent", payment_intent: "pi_reconcile" },
        },
      ],
    },
    metadata: {},
    lines: {
      data: [
        {
          price: null,
          pricing: {
            type: "price_details",
            price_details: { price: "price_reconcile" },
          },
          amount: 900,
          period: { start: 1_767_225_600, end: 1_769_904_000 },
        },
      ],
    },
  };
}

describe("reconciled subscription invoice provider timestamps", () => {
  it.each(["preBasil", "postBasil"] as const)(
    "normalizes %s paid invoices returned by reconciliation",
    async (generation) => {
      const { instance, listInvoices } = providerWithInvoice(
        paidInvoice(generation, { created: 100, paidAt: 200 }),
      );

      const [event] = await instance.listPaidSubscriptionInvoices(
        "sub_reconcile",
        "price_reconcile",
      );

      expect(listInvoices).toHaveBeenCalledWith({
        subscription: "sub_reconcile",
        status: "paid",
        limit: 100,
      });
      expect(event).toMatchObject({
        type: "subscription_renewed",
        providerSubscriptionRef: "sub_reconcile",
        providerInvoiceRef: `in_reconcile_${generation}`,
        localSubscriptionId: "11111111-1111-4111-8111-111111111111",
        providerPaymentRef: "pi_reconcile",
        providerPriceRef: "price_reconcile",
        currency: "usd",
        providerCreatedAt: new Date(200_000),
        lines: [
          expect.objectContaining({
            providerPriceRef: "price_reconcile",
            periodStart: new Date(1_767_225_600 * 1000),
            periodEnd: new Date(1_769_904_000 * 1000),
            amountMinor: 900,
          }),
        ],
      });
    },
  );

  it("uses Stripe status_transitions.paid_at instead of local wall time", async () => {
    const { instance } = providerWithInvoice(
      paidInvoice("preBasil", { created: 100, paidAt: 200 }),
    );

    const [event] = await instance.listPaidSubscriptionInvoices(
      "sub_reconcile",
      "price_reconcile",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(event!.providerCreatedAt).toEqual(new Date(200_000));
  });

  it("falls back to the provider invoice creation time when paid_at is absent", async () => {
    const { instance } = providerWithInvoice(
      paidInvoice("preBasil", { created: 300, paidAt: null }),
    );

    const [event] = await instance.listPaidSubscriptionInvoices(
      "sub_reconcile",
      "price_reconcile",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(event!.providerCreatedAt).toEqual(new Date(300_000));
  });
});
