import { TierManager } from "@/components/admin/tier-manager";
import { getStripeConfig } from "@/modules/config";
import { getT } from "@/modules/i18n/server";
import { listTiers } from "@/modules/membership";
import { resolveStoredEntitlements } from "@/modules/membership/entitlements";

export const dynamic = "force-dynamic";

export default async function AdminTiersPage() {
  const [tiers, stripe, t] = await Promise.all([listTiers(), getStripeConfig(), getT()]);
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.tiers.title")}</h1>
      <TierManager
        defaultCurrency={stripe.currency}
        tiers={tiers.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          description: t.description,
          priceLabel: t.priceLabel,
          priceAmountMinor: t.priceAmountMinor,
          stripePriceId: t.stripePriceId,
          currency: t.currency,
          level: t.level,
          durationDays: t.durationDays,
          purchaseEnabled: t.purchaseEnabled,
          isActive: t.isActive,
          sortOrder: t.sortOrder,
          entitlements: resolveStoredEntitlements(t.entitlements),
        }))}
      />
    </div>
  );
}
