import Link from "next/link";

import type { Translate } from "@/modules/i18n";
import type { PostCardView } from "@/modules/theme/types";

import { PostVisibilityBadge } from "./post-visibility-badge";

export function PostCard({ post, t }: { post: PostCardView; t: Translate }) {
  return (
    <Link
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
        <h2 className="line-clamp-2 font-semibold leading-6 group-hover:text-primary">
          {post.title}
        </h2>
        {post.summary && (
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
            {post.summary}
          </p>
        )}
      </div>
    </Link>
  );
}
