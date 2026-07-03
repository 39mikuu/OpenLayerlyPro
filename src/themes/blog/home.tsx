import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { HomeView } from "@/modules/theme/types";

import { PostCard } from "./post-card";

/**
 * 博客主题首页：作者简介 + 文章列表流。会员等级只保留一条紧凑入口，
 * 详细选购交给 /tiers（复用内置主题的 Tiers 页）。
 */
export function Home({ view, t }: { view: HomeView; t: Translate }) {
  const creatorName = view.artistName || view.siteName;

  return (
    <div className="space-y-10">
      <section className="space-y-3 border-b pb-8">
        <div className="flex items-center gap-4">
          {view.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={view.avatarUrl}
              alt={creatorName}
              className="size-14 shrink-0 rounded-full border object-cover"
            />
          ) : null}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">{creatorName}</h1>
            {view.siteName !== creatorName && (
              <p className="text-sm text-muted-foreground">{view.siteName}</p>
            )}
          </div>
        </div>
        {view.bio && (
          <p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{view.bio}</p>
        )}
        {view.socialLinks.length > 0 && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {view.socialLinks.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                {link.name}
              </a>
            ))}
          </p>
        )}
      </section>

      {view.tiers.length > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span className="font-semibold">{t("home.supportPlans")}</span>
            <span className="text-muted-foreground">
              {view.tiers.map((tier) => `${tier.name} ${tier.priceLabel}`).join(" · ")}
            </span>
          </p>
          <Button size="sm" asChild>
            <Link href="/tiers">{t("home.becomeMember")}</Link>
          </Button>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-lg font-bold tracking-tight">{t("home.latest")}</h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/posts" className="gap-1">
              {t("home.all")}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>

        {view.latestPosts.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("home.empty")}</p>
        ) : (
          <div className="divide-y border-t">
            {view.latestPosts.map((post) => (
              <PostCard key={post.slug} post={post} t={t} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
