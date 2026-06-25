import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { getActiveMembership, listTiers } from "@/modules/membership";
import { getActiveTheme, type TierCardView } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function TiersPage() {
  const user = await getCurrentUser();
  const [tiers, active, theme, t] = await Promise.all([
    listTiers({ activeOnly: true }),
    user ? getActiveMembership(user.id) : Promise.resolve(null),
    getActiveTheme(),
    getT(),
  ]);

  const tierCards: TierCardView[] = tiers.map((tier) => ({
    id: tier.id,
    name: tier.name,
    priceLabel: tier.priceLabel,
    description: tier.description,
    durationDays: tier.durationDays,
    purchaseEnabled: tier.purchaseEnabled,
    subscriptionEnabled: tier.purchaseEnabled && Boolean(tier.stripePriceId),
  }));

  const Tiers = theme.components.Tiers;
  return (
    <Tiers
      t={t}
      view={{
        isLoggedIn: !!user,
        activeMembership: active
          ? { tierName: active.tier.name, endsAt: active.membership.endsAt }
          : null,
        tiers: tierCards,
      }}
    />
  );
}
