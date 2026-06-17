import { ArrowRight, ExternalLink } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { HomeView } from "@/modules/theme/types";

import { PostVisibilityBadge } from "./post-visibility-badge";

function avatarFallback(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "C";
}

export function Home({ view, t }: { view: HomeView; t: Translate }) {
  const creatorName = view.artistName || view.siteName;

  return (
    <div className="space-y-12">
      <section className="flex flex-col gap-6 py-2 sm:flex-row sm:items-start">
        {view.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={view.avatarUrl}
            alt={creatorName}
            className="size-28 shrink-0 rounded-full border border-border/80 object-cover shadow-sm sm:size-32"
          />
        ) : (
          <div className="flex size-28 shrink-0 items-center justify-center rounded-full border border-blue-100 bg-blue-50 text-3xl font-bold text-blue-600 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300 sm:size-32">
            {avatarFallback(creatorName)}
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{creatorName}</h1>
            {view.siteName !== creatorName && (
              <p className="mt-1 text-sm text-muted-foreground">{view.siteName}</p>
            )}
          </div>
          {view.bio && (
            <p className="max-w-2xl whitespace-pre-wrap text-sm leading-7 text-muted-foreground sm:text-base">
              {view.bio}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild className="rounded-lg px-5">
              <Link href="/tiers">{t("home.becomeMember")}</Link>
            </Button>
            {view.socialLinks.map((link) => (
              <Button key={link.url} variant="outline" size="sm" asChild>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.name}
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-5 border-t pt-10">
        <div>
          <h2 className="text-xl font-bold tracking-tight">{t("home.supportPlans")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("home.supportPlansHint")}</p>
        </div>

        {view.tiers.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card px-5 py-8 text-center">
            <p className="text-sm text-muted-foreground">{t("home.noPlans")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
            {view.tiers.map((tier) => (
              <article
                key={tier.id}
                className="flex min-h-64 flex-col rounded-xl border bg-card p-5 text-card-foreground shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_6px_20px_rgba(15,23,42,0.07)]"
              >
                <h3 className="font-semibold">{tier.name}</h3>
                <p className="mt-3 text-2xl font-bold tracking-tight text-primary">
                  {tier.priceLabel}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("tiers.duration", { days: tier.durationDays })}
                </p>
                <div className="mt-5 flex-1 text-sm leading-6 text-muted-foreground">
                  {tier.description ? (
                    <p className="whitespace-pre-wrap">{tier.description}</p>
                  ) : (
                    <p>{t("home.planFallback")}</p>
                  )}
                </div>
                {tier.purchaseEnabled ? (
                  <Button className="mt-5 w-full" asChild>
                    <Link href={view.isLoggedIn ? `/checkout/${tier.id}` : "/login"}>
                      {view.isLoggedIn ? t("tiers.open") : t("tiers.loginToOpen")}
                    </Link>
                  </Button>
                ) : (
                  <Button className="mt-5 w-full" variant="outline" disabled>
                    {t("tiers.notPurchasable")}
                  </Button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-5 border-t pt-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight">{t("home.latest")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("home.latestHint")}</p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/posts" className="gap-1">
              {t("home.all")}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>

        {view.latestPosts.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card px-5 py-8 text-center">
            <p className="text-sm text-muted-foreground">{t("home.empty")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {view.latestPosts.map((post) => (
              <Link
                key={post.slug}
                href={`/posts/${post.slug}`}
                className="group flex gap-4 rounded-xl border bg-card p-3 text-card-foreground shadow-[0_1px_3px_rgba(15,23,42,0.03)] transition hover:border-primary/30 hover:shadow-[0_5px_18px_rgba(15,23,42,0.06)] sm:p-4"
              >
                {post.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={post.coverUrl}
                    alt={post.title}
                    className="h-24 w-28 shrink-0 rounded-lg object-cover sm:h-28 sm:w-40"
                  />
                ) : (
                  <div className="h-24 w-28 shrink-0 rounded-lg border border-blue-100 bg-gradient-to-br from-blue-50 via-slate-50 to-pink-50 dark:border-blue-950 dark:from-blue-950/40 dark:via-slate-950 dark:to-pink-950/30 sm:h-28 sm:w-40" />
                )}
                <div className="min-w-0 flex-1 py-0.5">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <PostVisibilityBadge visibility={post.visibility} t={t} />
                    {post.publishedAt && (
                      <time className="text-xs text-muted-foreground">
                        {post.publishedAt.toISOString().slice(0, 10)}
                      </time>
                    )}
                  </div>
                  <h3 className="line-clamp-2 font-semibold leading-6 group-hover:text-primary">
                    {post.title}
                  </h3>
                  {post.summary && (
                    <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                      {post.summary}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
