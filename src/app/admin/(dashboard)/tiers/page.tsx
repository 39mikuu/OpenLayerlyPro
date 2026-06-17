import { TierManager } from "@/components/admin/tier-manager";
import { getT } from "@/modules/i18n/server";
import { listTiers } from "@/modules/membership";

export const dynamic = "force-dynamic";

export default async function AdminTiersPage() {
  const tiers = await listTiers();
  const t = await getT();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.tiers.title")}</h1>
      <TierManager
        tiers={tiers.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          description: t.description,
          priceLabel: t.priceLabel,
          level: t.level,
          durationDays: t.durationDays,
          purchaseEnabled: t.purchaseEnabled,
          isActive: t.isActive,
          sortOrder: t.sortOrder,
        }))}
      />
    </div>
  );
}
