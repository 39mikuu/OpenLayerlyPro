import { notFound, redirect } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getStripeConfig } from "@/modules/config";
import { getT } from "@/modules/i18n/server";
import { getTierById } from "@/modules/membership";
import { listPaymentMethods } from "@/modules/payment";
import { type CheckoutMethodView, getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function CheckoutPage({ params }: { params: Promise<{ tierId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { tierId } = await params;
  const tier = await getTierById(tierId);
  if (!tier || !tier.isActive || !tier.purchaseEnabled) notFound();

  const [methods, stripe, theme, t] = await Promise.all([
    listPaymentMethods({ activeOnly: true }),
    getStripeConfig(),
    getActiveTheme(),
    getT(),
  ]);

  const methodViews: CheckoutMethodView[] = methods.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    qrFileId: m.qrFileId,
  }));

  const Checkout = theme.components.Checkout;
  return (
    <Checkout
      t={t}
      view={{
        tier: {
          id: tier.id,
          name: tier.name,
          priceLabel: tier.priceLabel,
          durationDays: tier.durationDays,
        },
        methods: methodViews,
        autoPaymentAvailable: Boolean(
          stripe.enabled && stripe.configured && tier.priceAmountMinor !== null && tier.currency,
        ),
      }}
    />
  );
}
