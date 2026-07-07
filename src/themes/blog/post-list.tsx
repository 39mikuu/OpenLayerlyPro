import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { Translate } from "@/modules/i18n";
import type { PostListView } from "@/modules/theme/types";

import { PostCard } from "./post-card";

export function PostList({ view, t }: { view: PostListView; t: Translate }) {
  return (
    <div className="space-y-6">
      <header className="border-b pb-5">
        <h1 className="text-2xl font-bold tracking-tight">{t("posts.title")}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("posts.subtitle")}</p>
      </header>

      {view.posts.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("posts.empty")}</p>
      ) : (
        <div className="divide-y">
          {view.posts.map((post) => (
            <PostCard key={post.slug} post={post} t={t} />
          ))}
        </div>
      )}
      {view.nextHref && (
        <div className="flex justify-center border-t pt-6">
          <Button asChild variant="ghost" size="sm">
            <Link href={view.nextHref}>{t("posts.nextPage")}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
