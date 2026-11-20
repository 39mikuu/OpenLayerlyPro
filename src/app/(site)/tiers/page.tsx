import type { Metadata } from "next";

import { getEnv } from "@/lib/env";
import { getOAuthApiBasePath } from "@/modules/auth/oauth";
import { getCurrentUser } from "@/modules/auth/session";
import { requireInsidePage } from "@/modules/blog/reader-page";
import { buildListPageSeoCopy, buildSiteMetadata } from "@/modules/content/seo";
import { getT } from "@/modules/i18n/server";
import { getActiveMembership, listTiers } from "@/modules/membership";
import { describeEntitlements } from "@/modules/membership/entitlements";
import { getActiveTheme, type TierCardView } from "@/modules/theme";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return buildSiteMetadata("/tiers", buildListPageSeoCopy("tiers"));
}

export default async function TiersPage() {
  const user = getEnv().PERSONAL_BLOG_MODE
    ? await requireInsidePage("/inside/tiers")
    : await getCurrentUser();
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
    entitlements: describeEntitlements(tier.entitlements, t),
  }));

  const Tiers = theme.components.Tiers;
  return (
    <Tiers
      t={t}
      view={{
        publicBasePath: getOAuthApiBasePath(),
        isLoggedIn: !!user,
        readerArea: getEnv().PERSONAL_BLOG_MODE,
        activeMembership: active
          ? {
              tierName: active.tier.name,
              endsAt: active.membership.endsAt,
              entitlements: describeEntitlements(active.tier.entitlements, t),
            }
          : null,
        tiers: tierCards,
      }}
    />
  );
}
