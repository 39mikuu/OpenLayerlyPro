import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { PostListView } from "@/modules/theme/types";

import { PostCard } from "./post-card";
import { ArchiveSidebar } from "./sidebar";

export function PostList({ view, t }: { view: PostListView; t: Translate }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0 space-y-5">
        <header className="rounded-3xl border bg-card px-6 py-7 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">
            {t("theme.wordpress.archive")}
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight">{t("posts.title")}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("posts.subtitle")}</p>
        </header>

        {view.posts.length === 0 ? (
          <p className="rounded-2xl border bg-card py-12 text-center text-sm text-muted-foreground">
            {t("posts.empty")}
          </p>
        ) : (
          <div className="space-y-5">
            {view.posts.map((post) => (
              <PostCard key={post.slug} post={post} t={t} />
            ))}
          </div>
        )}
        {view.nextHref && (
          <div className="flex justify-center pt-2">
            <Button asChild variant="outline">
              <Link href={view.nextHref}>{t("posts.nextPage")}</Link>
            </Button>
          </div>
        )}
      </section>
      <ArchiveSidebar posts={view.posts} t={t} />
    </div>
  );
}
