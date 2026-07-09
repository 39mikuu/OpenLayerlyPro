import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { HomeView } from "@/modules/theme/types";

import { PostCard } from "./post-card";
import { AuthorSidebar } from "./sidebar";

export function Home({ view, t }: { view: HomeView; t: Translate }) {
  const creatorName = view.artistName || view.siteName;

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border bg-card px-6 py-8 shadow-sm sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">
          {t("theme.wordpress.label")}
        </p>
        <h1 className="mt-3 max-w-3xl text-3xl font-black leading-tight tracking-tight sm:text-5xl">
          {creatorName}
        </h1>
        {view.bio && (
          <p className="mt-4 max-w-2xl whitespace-pre-wrap text-base leading-8 text-muted-foreground">
            {view.bio}
          </p>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 space-y-5">
          <div className="flex items-end justify-between gap-4 border-b pb-3">
            <div>
              <h2 className="text-xl font-bold tracking-tight">{t("home.latest")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{view.siteName}</p>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/posts" className="gap-1">
                {t("home.all")}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
          {view.latestPosts.length === 0 ? (
            <p className="rounded-2xl border bg-card py-12 text-center text-sm text-muted-foreground">
              {t("home.empty")}
            </p>
          ) : (
            <div className="space-y-5">
              {view.latestPosts.map((post) => (
                <PostCard key={post.slug} post={post} t={t} />
              ))}
            </div>
          )}
        </section>
        <AuthorSidebar view={view} t={t} />
      </div>
    </div>
  );
}
