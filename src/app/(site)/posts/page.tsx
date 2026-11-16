import type { Metadata } from "next";
import Link from "next/link";

import { getEnv } from "@/lib/env";
import { getBlogCopy } from "@/modules/blog/copy";
import { listPublishedPostsPage, localizePostCards } from "@/modules/content";
import { buildListPageSeoCopy, buildSiteMetadata } from "@/modules/content/seo";
import { getBlogLocale, getBlogT, getT, resolveLocale } from "@/modules/i18n/server";
import { getPostsTaxonomy } from "@/modules/taxonomy";
import { getActiveTheme, type PostCardView } from "@/modules/theme";
import { BlogSearch, ReaderCard } from "@/themes/blog/personal";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const env = getEnv();
  return buildSiteMetadata(
    "/posts",
    buildListPageSeoCopy("posts", env.PERSONAL_BLOG_MODE ? env.BLOG_LOCALE : undefined),
  );
}

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; tag?: string; cursor?: string; q?: string }>;
}) {
  const filters = await searchParams;
  const personalBlog = getEnv().PERSONAL_BLOG_MODE;
  const search = typeof filters.q === "string" ? filters.q.trim().slice(0, 120) : "";
  const [page, theme, t, locale] = await Promise.all([
    listPublishedPostsPage({
      cursor: filters.cursor,
      categorySlug: filters.category,
      tagSlug: filters.tag,
      audience: personalBlog ? "public" : undefined,
      search: personalBlog ? search : undefined,
      searchLocale: personalBlog ? getBlogLocale() : undefined,
    }),
    getActiveTheme(),
    personalBlog ? getBlogT() : getT(),
    personalBlog ? getBlogLocale() : resolveLocale(),
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
  if (personalBlog) {
    const copy = getBlogCopy(locale);
    if (search) nextParams.set("q", search);
    return (
      <section className="mx-auto max-w-3xl">
        <header className="space-y-4 border-b pb-5">
          <h1 className="text-3xl font-bold tracking-tight">{copy.archive}</h1>
          <BlogSearch copy={copy} value={search} />
        </header>
        {cards.map((post) => (
          <ReaderCard
            key={post.slug}
            title={post.title}
            summary={post.summary}
            date={post.publishedAt}
            href={`/posts/${post.slug}`}
            image={post.coverUrl}
          />
        ))}
        {cards.length === 0 && (
          <p className="py-8 text-sm text-muted-foreground">{t("posts.empty")}</p>
        )}
        {page.nextCursor && (
          <Link href={`/posts?${nextParams}`} className="inline-block py-4 underline">
            {t("posts.nextPage")}
          </Link>
        )}
      </section>
    );
  }
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
