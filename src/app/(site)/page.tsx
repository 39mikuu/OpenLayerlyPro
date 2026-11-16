import type { Metadata } from "next";
import Link from "next/link";

import { getEnv } from "@/lib/env";
import { getOAuthApiBasePath } from "@/modules/auth/oauth";
import { getCurrentUser } from "@/modules/auth/session";
import { getBlogCopy } from "@/modules/blog/copy";
import { listPublishedPostsPage, localizePostCards, POSTS_PAGE_SIZE } from "@/modules/content";
import { listPublicPostProjectionPage } from "@/modules/content/public-projection";
import { buildSiteMetadata } from "@/modules/content/seo";
import { getBlogLocale, getBlogT, getT, resolveLocale } from "@/modules/i18n/server";
import { listTiers } from "@/modules/membership";
import { describeEntitlements } from "@/modules/membership/entitlements";
import { getPublicSiteInfo } from "@/modules/site";
import { getActiveTheme, type HomePostView, type TierCardView } from "@/modules/theme";
import { BlogSearch, ReaderCard } from "@/themes/blog/personal";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return buildSiteMetadata("/");
}

async function PersonalBlogHome() {
  const locale = getBlogLocale();
  const t = getBlogT();
  const copy = getBlogCopy(locale);
  const [site, page] = await Promise.all([
    getPublicSiteInfo(),
    listPublicPostProjectionPage({ limit: POSTS_PAGE_SIZE, locale }),
  ]);
  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-12">
      <header className="min-w-0 space-y-4 md:sticky md:top-8 md:self-start">
        {site.artistAvatarFileId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/files/${site.artistAvatarFileId}/download`}
            alt=""
            className="size-16 rounded-xl border object-cover"
          />
        )}
        <h1 className="break-words text-3xl font-bold tracking-tight sm:text-4xl">
          {site.siteName}
        </h1>
        {site.artistName && site.artistName !== site.siteName && (
          <p className="font-medium">{site.artistName}</p>
        )}
        {site.artistBio && (
          <p className="whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground">
            {site.artistBio}
          </p>
        )}
        <BlogSearch copy={copy} />
      </header>
      <section className="min-w-0 border-t pt-4 md:border-t-0 md:pt-0">
        <div className="flex items-center justify-between gap-3 border-b pb-3">
          <h2 className="text-lg font-semibold">{t("home.latest")}</h2>
          <Link href="/posts" className="text-sm text-muted-foreground hover:underline">
            {copy.archive}
          </Link>
        </div>
        {page.posts.map((post) => (
          <ReaderCard
            key={post.slug}
            title={post.title}
            summary={post.summary}
            date={post.publishedAt}
            href={`/posts/${post.slug}`}
            image={post.coverFileId ? `/api/files/${post.coverFileId}/download` : null}
          />
        ))}
        {page.posts.length === 0 && (
          <p className="py-8 text-sm text-muted-foreground">{t("home.empty")}</p>
        )}
      </section>
    </div>
  );
}

export default async function HomePage() {
  if (getEnv().PERSONAL_BLOG_MODE) return PersonalBlogHome();
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
    entitlements: describeEntitlements(tier.entitlements, t),
  }));

  const Home = theme.components.Home;
  return (
    <Home
      t={t}
      view={{
        publicBasePath: getOAuthApiBasePath(),
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
