import { notFound } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getTranslationConfig } from "@/modules/config";
import {
  canAccessPost,
  getLocalizedPost,
  getPublishedPostBySlug,
  getRequiredTier,
  listPostFiles,
} from "@/modules/content";
import { renderMarkdown } from "@/modules/content/markdown";
import { getT, resolveLocale } from "@/modules/i18n/server";
import { getPostTaxonomy } from "@/modules/taxonomy";
import { getActiveTheme, type PostAttachmentView, type PostImageView } from "@/modules/theme";
import { shouldShowMachineTranslationLabel } from "@/modules/translation/policy";

export const dynamic = "force-dynamic";

export default async function PostDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [post, user, locale] = await Promise.all([
    getPublishedPostBySlug(slug),
    getCurrentUser(),
    resolveLocale(),
  ]);
  if (!post) notFound();

  const [localizedPost, allowed, requiredTier, theme, t, translationConfig, taxonomy] =
    await Promise.all([
      getLocalizedPost(post, locale),
      canAccessPost(user, post),
      getRequiredTier(post),
      getActiveTheme(),
      getT(),
      getTranslationConfig(),
      getPostTaxonomy(post.id),
    ]);

  let body: string | null = null;
  let bodyHtml: string | null = null;
  let images: PostImageView[] = [];
  let attachments: PostAttachmentView[] = [];
  if (allowed) {
    const files = await listPostFiles(post.id);
    body = localizedPost.body;
    bodyHtml = renderMarkdown(localizedPost.body, { embedMode: "public" });
    images = files
      .filter((f) => f.link.kind === "image")
      .map((f) => ({ url: `/api/files/${f.file.id}/download`, alt: f.file.originalName }));
    attachments = files
      .filter((f) => f.link.kind === "attachment")
      .map((f) => ({
        downloadHref: `/download/${f.file.id}`,
        name: f.file.originalName,
        sizeBytes: f.file.sizeBytes,
      }));
  }

  const PostDetail = theme.components.PostDetail;
  return (
    <PostDetail
      t={t}
      view={{
        title: localizedPost.title,
        publishedAt: post.publishedAt,
        visibility: post.visibility,
        requiredTierName: requiredTier?.name ?? null,
        summary: localizedPost.summary,
        coverUrl: post.coverFileId ? `/api/files/${post.coverFileId}/download` : null,
        isLoggedIn: !!user,
        allowed,
        body,
        bodyHtml,
        images,
        attachments,
        machineTranslated: shouldShowMachineTranslationLabel(
          translationConfig,
          localizedPost.translationSource,
        ),
        categories: taxonomy.categories,
        tags: taxonomy.tags,
      }}
    />
  );
}
