import type { Metadata } from "next";

import { getCurrentUser } from "@/modules/auth/session";
import { listPublishedPostsPage, localizePostCards, POSTS_PAGE_SIZE } from "@/modules/content";
import { buildSiteMetadata } from "@/modules/content/seo";
import { getT, resolveLocale } from "@/modules/i18n/server";
import { listTiers } from "@/modules/membership";
import { getPublicSiteInfo } from "@/modules/site";
import { getActiveTheme, type HomePostView, type TierCardView } from "@/modules/theme";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return buildSiteMetadata("/");
}

export default async function HomePage() {
  const [site, postPage, tiers, user, theme, t, locale] = await Promise.all([
    getPublicSiteInfo(),
    listPublishedPostsPage({ limit: POSTS_PAGE_SIZE }),
    listTiers({ activeOnly: true }),
    getCurrentUser(),
    getActiveTheme(),
    getT(),
    resolveLocale(),
  ]);
  const localizedPosts = await localizePostCards(postPage.posts, locale);

  const latestPosts: HomePostView[] = localizedPosts.map((post) => ({
    slug: post.slug,
    title: post.title,
    summary: post.summary,
    coverUrl: post.coverFileId ? `/api/files/${post.coverFileId}/download` : null,
    visibility: post.visibility,
    publishedAt: post.publishedAt,
  }));
  const tierCards: TierCardView[] = tiers.slice(0, 4).map((tier) => ({
    id: tier.id,
    name: tier.name,
    priceLabel: tier.priceLabel,
    description: tier.description,
    durationDays: tier.durationDays,
    purchaseEnabled: tier.purchaseEnabled,
    subscriptionEnabled: tier.purchaseEnabled && Boolean(tier.stripePriceId),
  }));

  const Home = theme.components.Home;
  return (
    <Home
      t={t}
      view={{
        siteName: site.siteName,
        artistName: site.artistName,
        bio: site.artistBio,
        avatarUrl: site.artistAvatarFileId
          ? `/api/files/${site.artistAvatarFileId}/download`
          : null,
        socialLinks: site.socialLinks
          .filter((l) => l.enabled !== false)
          .map((l) => ({ name: l.name, url: l.url })),
        isLoggedIn: !!user,
        tiers: tierCards,
        latestPosts,
      }}
    />
  );
}
