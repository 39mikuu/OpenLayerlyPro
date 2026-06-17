import { listPosts, localizePostCards } from "@/modules/content";
import { getT, resolveLocale } from "@/modules/i18n/server";
import { getActiveTheme, type PostCardView } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function PostsPage() {
  const [posts, theme, t, locale] = await Promise.all([
    listPosts({ publishedOnly: true }),
    getActiveTheme(),
    getT(),
    resolveLocale(),
  ]);
  const localizedPosts = await localizePostCards(posts, locale);

  const cards: PostCardView[] = localizedPosts.map((post) => ({
    slug: post.slug,
    title: post.title,
    summary: post.summary,
    coverUrl: post.coverFileId ? `/api/files/${post.coverFileId}/download` : null,
    visibility: post.visibility,
    publishedAt: post.publishedAt,
  }));

  const PostList = theme.components.PostList;
  return <PostList view={{ posts: cards }} t={t} />;
}
