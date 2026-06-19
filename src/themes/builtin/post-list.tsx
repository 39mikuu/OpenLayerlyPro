import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { PostListView } from "@/modules/theme/types";

import { PostCard } from "./post-card";

export function PostList({ view, t }: { view: PostListView; t: Translate }) {
  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <header className="border-b pb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("posts.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("posts.subtitle")}</p>
      </header>

      {view.posts.length === 0 ? (
        <p className="rounded-xl border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
          {t("posts.empty")}
        </p>
      ) : (
        <div className="space-y-3">
          {view.posts.map((post) => (
            <PostCard key={post.slug} post={post} t={t} />
          ))}
        </div>
      )}
      {view.nextHref && (
        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link href={view.nextHref}>{t("posts.nextPage")}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
