import { notFound } from "next/navigation";

import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/modules/auth/session";
import { getBlogCopy } from "@/modules/blog/copy";
import { requireInsidePage } from "@/modules/blog/reader-page";
import { getTranslationConfig } from "@/modules/config";
import {
  canAccessPost,
  getLocalizedPost,
  getPublishedPostBySlug,
  getRequiredTier,
  listPostFiles,
} from "@/modules/content";
import { renderBlogArticle, renderMarkdown } from "@/modules/content/markdown";
import { isInlineVideoMime } from "@/modules/download/video";
import { getBlogLocale, getBlogT, getT, resolveLocale } from "@/modules/i18n/server";
import { getPostTaxonomy } from "@/modules/taxonomy";
import { getActiveTheme, type PostAttachmentView, type PostImageView } from "@/modules/theme";
import { shouldShowMachineTranslationLabel } from "@/modules/translation/policy";
import { PostDetail as BlogPostDetail } from "@/themes/builtin/post-detail";

export async function renderPostDetail(slug: string, inside = false) {
  const personalBlog = getEnv().PERSONAL_BLOG_MODE;
  const publicBlog = personalBlog && !inside;
  const userPromise = inside
    ? requireInsidePage(`/inside/posts/${encodeURIComponent(slug)}`)
    : publicBlog
      ? Promise.resolve(null)
      : getCurrentUser();
  const [post, user, locale] = await Promise.all([
    getPublishedPostBySlug(slug),
    userPromise,
    publicBlog ? getBlogLocale() : resolveLocale(),
  ]);
  if (
    !post ||
    (publicBlog && post.visibility !== "public") ||
    (inside && post.visibility === "public")
  )
    notFound();

  const [allowed, requiredTier, theme, t, translationConfig, taxonomy] = await Promise.all([
    publicBlog ? true : canAccessPost(user, post),
    getRequiredTier(post),
    personalBlog ? null : getActiveTheme(),
    publicBlog ? getBlogT() : getT(),
    getTranslationConfig(),
    getPostTaxonomy(post.id),
  ]);
  const localizedPost = await getLocalizedPost(post, locale);
  const blogArticle = personalBlog && allowed ? renderBlogArticle(localizedPost.body) : null;

  let body: string | null = null;
  let bodyHtml: string | null = null;
  let images: PostImageView[] = [];
  let attachments: PostAttachmentView[] = [];
  if (allowed) {
    const files = await listPostFiles(post.id);
    body = localizedPost.body;
    bodyHtml = blogArticle?.html ?? renderMarkdown(localizedPost.body, { embedMode: "public" });
    images = files
      .filter((f) => f.link.kind === "image")
      .map((f) => ({ url: `/api/files/${f.file.id}/download`, alt: f.file.originalName }));
    attachments = files
      .filter((f) => f.link.kind === "attachment")
      .map((f) => {
        const inlineCandidate = isInlineVideoMime(f.file.mimeType);
        return {
          downloadHref: `/download/${f.file.id}`,
          playHref: inlineCandidate ? `/api/files/${f.file.id}/download?mode=inline` : undefined,
          name: f.file.originalName,
          sizeBytes: f.file.sizeBytes,
          mimeType: f.file.mimeType,
          inlineCandidate,
        };
      });
  }

  const PostDetail = theme?.components.PostDetail ?? BlogPostDetail;
  const copy = getBlogCopy(locale);
  return (
    <PostDetail
      t={t}
      view={{
        readerArea: inside,
        blogArticle: blogArticle
          ? {
              toc: blogArticle.toc,
              tocLabel: copy.toc,
              codeLabels: { copy: copy.copy, copied: copy.copied, copyFailed: copy.copyFailed },
            }
          : undefined,
        title: localizedPost.title,
        publishedAt: post.publishedAt,
        visibility: post.visibility,
        requiredTierName: requiredTier?.name ?? null,
        summary: localizedPost.summary,
        coverUrl:
          post.coverFileId && (!inside || allowed)
            ? `/api/files/${post.coverFileId}/download`
            : null,
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
