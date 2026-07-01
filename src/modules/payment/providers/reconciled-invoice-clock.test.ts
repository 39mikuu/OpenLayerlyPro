import { describe, expect, it, vi } from "vitest";

import { StripePaymentProvider } from "./stripe";

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

function paidInvoice(input: { created: number; paidAt?: number | null }) {
  return {
    id: "in_reconcile",
    subscription: "sub_reconcile",
    payment_intent: "pi_reconcile",
    currency: "usd",
    created: input.created,
    status_transitions: { paid_at: input.paidAt ?? null },
    metadata: { providerPriceRef: "price_reconcile" },
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

describe("reconciled subscription invoice provider timestamps", () => {
  it("uses Stripe status_transitions.paid_at instead of local wall time", async () => {
    const { instance } = providerWithInvoice(paidInvoice({ created: 100, paidAt: 200 }));

    const [event] = await instance.listPaidSubscriptionInvoices(
      "sub_reconcile",
      "price_reconcile",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(event!.providerCreatedAt).toEqual(new Date(200_000));
  });

  it("falls back to the provider invoice creation time when paid_at is absent", async () => {
    const { instance } = providerWithInvoice(paidInvoice({ created: 300, paidAt: null }));

    const [event] = await instance.listPaidSubscriptionInvoices(
      "sub_reconcile",
      "price_reconcile",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(event!.providerCreatedAt).toEqual(new Date(300_000));
  });
});
