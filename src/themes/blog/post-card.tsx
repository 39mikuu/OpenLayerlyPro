import Link from "next/link";

import type { Translate } from "@/modules/i18n";
import type { PostCardView } from "@/modules/theme/types";
import { PostVisibilityBadge } from "@/themes/builtin/post-visibility-badge";

/** 博客主题的文章条目：文字优先（日期 + 标题 + 摘要），不渲染封面缩略图。 */
export function PostCard({ post, t }: { post: PostCardView; t: Translate }) {
  return (
    <article className="group py-5">
      <Link href={`/posts/${post.slug}`} className="block space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {post.publishedAt && <time>{post.publishedAt.toISOString().slice(0, 10)}</time>}
          {post.visibility !== "public" && (
            <PostVisibilityBadge visibility={post.visibility} t={t} />
          )}
        </div>
        <h2 className="text-lg font-semibold leading-snug underline-offset-4 group-hover:underline">
          {post.title}
        </h2>
        {post.summary && (
          <p className="line-clamp-2 text-sm leading-7 text-muted-foreground">{post.summary}</p>
        )}
        {(post.categories?.length || post.tags?.length) && (
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {post.categories?.map((category) => (
              <span key={category.slug}>{category.name}</span>
            ))}
            {post.tags?.map((tag) => (
              <span key={tag.slug}>#{tag.name}</span>
            ))}
          </p>
        )}
      </Link>
    </article>
  );
}
