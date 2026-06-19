import { listPosts, localizePostCards } from "@/modules/content";
import { getT, resolveLocale } from "@/modules/i18n/server";
import { getPostsTaxonomy } from "@/modules/taxonomy";
import { getActiveTheme, type PostCardView } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; tag?: string }>;
}) {
  const filters = await searchParams;
  const [posts, theme, t, locale] = await Promise.all([
    listPosts({
      publishedOnly: true,
      categorySlug: filters.category,
      tagSlug: filters.tag,
    }),
    getActiveTheme(),
    getT(),
    resolveLocale(),
  ]);
  const [localizedPosts, taxonomy] = await Promise.all([
    localizePostCards(posts, locale),
    getPostsTaxonomy(posts.map((post) => post.id)),
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
  return <PostList view={{ posts: cards }} t={t} />;
}
