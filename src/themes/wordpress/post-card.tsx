import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { Translate } from "@/modules/i18n";
import type { PostCardView } from "@/modules/theme/types";
import { PostVisibilityBadge } from "@/themes/builtin/post-visibility-badge";

export function PostCard({ post, t }: { post: PostCardView; t: Translate }) {
  return (
    <article className="group overflow-hidden rounded-2xl border bg-card shadow-sm transition-shadow hover:shadow-md">
      <Link href={`/posts/${post.slug}`} className="grid gap-0 sm:grid-cols-[180px_1fr]">
        {post.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.coverUrl}
            alt={post.title}
            className="h-44 w-full object-cover sm:h-full"
          />
        ) : (
          <div className="hidden bg-[linear-gradient(135deg,var(--muted),var(--accent))] sm:block" />
        )}
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {post.publishedAt && <time>{post.publishedAt.toISOString().slice(0, 10)}</time>}
            {post.visibility !== "public" && (
              <PostVisibilityBadge visibility={post.visibility} t={t} />
            )}
          </div>
          <h2 className="text-xl font-bold leading-snug tracking-tight underline-offset-4 group-hover:underline">
            {post.title}
          </h2>
          {post.summary && (
            <p className="line-clamp-3 text-sm leading-7 text-muted-foreground">{post.summary}</p>
          )}
          {((post.categories?.length ?? 0) > 0 || (post.tags?.length ?? 0) > 0) && (
            <div className="flex flex-wrap gap-2 text-xs">
              {post.categories?.map((category) => (
                <Badge key={category.slug} variant="secondary">
                  {category.name}
                </Badge>
              ))}
              {post.tags?.map((tag) => (
                <Badge key={tag.slug} variant="outline">
                  #{tag.name}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </Link>
    </article>
  );
}
