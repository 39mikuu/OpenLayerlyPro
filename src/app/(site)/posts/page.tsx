import type { Metadata } from "next";

import { listPublishedPostsPage, localizePostCards } from "@/modules/content";
import { buildListPageSeoCopy, buildSiteMetadata } from "@/modules/content/seo";
import { getT, resolveLocale } from "@/modules/i18n/server";
import { getPostsTaxonomy } from "@/modules/taxonomy";
import { getActiveTheme, type PostCardView } from "@/modules/theme";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return buildSiteMetadata("/posts", buildListPageSeoCopy("posts"));
}

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; tag?: string; cursor?: string }>;
}) {
  const filters = await searchParams;
  const [page, theme, t, locale] = await Promise.all([
    listPublishedPostsPage({
      cursor: filters.cursor,
      categorySlug: filters.category,
      tagSlug: filters.tag,
    }),
    getActiveTheme(),
    getT(),
    resolveLocale(),
  ]);
  const [localizedPosts, taxonomy] = await Promise.all([
    localizePostCards(page.posts, locale),
    getPostsTaxonomy(page.posts.map((post) => post.id)),
  ]);

  const cards: PostCardView[] = localizedPosts.map((post) => ({
    slug: post.slug,
    title: post.title,
    summary: post.summary,
    coverUrl: post.coverFileId ? `/api/files/${post.coverFileId}/download` : null,
    visibility: post.visibility,
    publishedAt: post.publishedAt,
    categories: taxonomy.get(post.id)?.categories ?? [],
    tags: taxonomy.get(post.id)?.tags ?? [],
  }));

  const PostList = theme.components.PostList;
  const nextParams = new URLSearchParams();
  if (page.nextCursor) nextParams.set("cursor", page.nextCursor);
  if (filters.category) nextParams.set("category", filters.category);
  if (filters.tag) nextParams.set("tag", filters.tag);
  return (
    <PostList
      view={{
        posts: cards,
        nextHref: page.nextCursor ? `/posts?${nextParams.toString()}` : null,
      }}
      t={t}
    />
  );
}
