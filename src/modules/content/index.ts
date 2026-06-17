import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import {
  type FileRecord,
  files,
  type MembershipTier,
  membershipTiers,
  type Post,
  type PostFile,
  postFiles,
  posts,
  type PostTranslation,
  postTranslations,
  type User,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { isLocale, type Locale } from "@/modules/i18n";
import { getActiveLevel } from "@/modules/membership";
import { recordEvent } from "@/modules/system/events";

export type PostInput = {
  title: string;
  slug: string;
  summary?: string | null;
  body?: string | null;
  coverFileId?: string | null;
  visibility: "public" | "login" | "member";
  requiredTierId?: string | null;
};

export async function createPost(input: PostInput): Promise<Post> {
  await assertValidTier(input);
  const [post] = await getDb()
    .insert(posts)
    .values({ ...input, status: "draft" })
    .returning();
  return post;
}

export async function updatePost(id: string, input: Partial<PostInput>): Promise<Post> {
  if (input.visibility === "member" || input.requiredTierId !== undefined) {
    const existing = await getPostById(id);
    if (!existing) throw new ApiError(404, "postNotFound");
    await assertValidTier({
      visibility: input.visibility ?? existing.visibility,
      requiredTierId:
        input.requiredTierId !== undefined ? input.requiredTierId : existing.requiredTierId,
    });
  }
  const [post] = await getDb()
    .update(posts)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(posts.id, id))
    .returning();
  if (!post) throw new ApiError(404, "postNotFound");
  return post;
}

async function assertValidTier(input: {
  visibility: string;
  requiredTierId?: string | null;
}): Promise<void> {
  if (input.visibility === "member" && !input.requiredTierId) {
    throw new ApiError(400, "memberTierRequired");
  }
}

export async function setPostStatus(
  id: string,
  status: "draft" | "published" | "archived",
): Promise<Post> {
  const patch: Partial<typeof posts.$inferInsert> = { status, updatedAt: new Date() };
  if (status === "published") {
    patch.publishedAt = new Date();
  }
  const [post] = await getDb().update(posts).set(patch).where(eq(posts.id, id)).returning();
  if (!post) throw new ApiError(404, "postNotFound");
  if (status === "published") {
    await recordEvent("post_published", { postId: id, slug: post.slug });
  }
  return post;
}

export async function deletePost(id: string): Promise<void> {
  await getDb().delete(posts).where(eq(posts.id, id));
}

export async function getPostById(id: string): Promise<Post | null> {
  const [post] = await getDb().select().from(posts).where(eq(posts.id, id)).limit(1);
  return post ?? null;
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const [post] = await getDb().select().from(posts).where(eq(posts.slug, slug)).limit(1);
  return post ?? null;
}

export async function listPosts(opts?: { publishedOnly?: boolean }): Promise<Post[]> {
  const db = getDb();
  if (opts?.publishedOnly) {
    return db
      .select()
      .from(posts)
      .where(eq(posts.status, "published"))
      .orderBy(desc(posts.publishedAt));
  }
  return db.select().from(posts).orderBy(desc(posts.createdAt));
}

export type LocalizedPost = Post & {
  contentLocale: string;
  isFallback: boolean;
  translationSource: PostTranslation["source"] | null;
};

function originalPost(post: Post, requestedLocale: Locale): LocalizedPost {
  return {
    ...post,
    contentLocale: post.originalLocale,
    isFallback: requestedLocale !== post.originalLocale,
    translationSource: null,
  };
}

function translatedPost(
  post: Post,
  translation: PostTranslation,
  requestedLocale: Locale,
): LocalizedPost {
  return {
    ...post,
    title: translation.title,
    summary: translation.summary,
    body: translation.body,
    contentLocale: translation.locale,
    isFallback: translation.locale !== requestedLocale,
    translationSource: translation.source,
  };
}

export async function getLocalizedPost(
  post: Post,
  locale: Locale,
  dbc: DbClient = getDb(),
): Promise<LocalizedPost> {
  if (locale === post.originalLocale) return originalPost(post, locale);

  const [translation] = await dbc
    .select()
    .from(postTranslations)
    .where(
      and(
        eq(postTranslations.postId, post.id),
        eq(postTranslations.locale, locale),
        eq(postTranslations.status, "published"),
      ),
    )
    .limit(1);

  return translation?.status === "published"
    ? translatedPost(post, translation, locale)
    : originalPost(post, locale);
}

export async function localizePostCards(
  postList: Post[],
  locale: Locale,
  dbc: DbClient = getDb(),
): Promise<LocalizedPost[]> {
  const ids = postList.filter((post) => post.originalLocale !== locale).map((post) => post.id);
  if (ids.length === 0) return postList.map((post) => originalPost(post, locale));

  const translations = await dbc
    .select()
    .from(postTranslations)
    .where(
      and(
        inArray(postTranslations.postId, ids),
        eq(postTranslations.locale, locale),
        eq(postTranslations.status, "published"),
      ),
    );
  const byPostId = new Map(
    translations
      .filter((translation) => translation.status === "published")
      .map((translation) => [translation.postId, translation]),
  );

  return postList.map((post) => {
    const translation = byPostId.get(post.id);
    return translation ? translatedPost(post, translation, locale) : originalPost(post, locale);
  });
}

export async function listPostTranslations(
  postId: string,
  dbc: DbClient = getDb(),
): Promise<PostTranslation[]> {
  return dbc
    .select()
    .from(postTranslations)
    .where(eq(postTranslations.postId, postId))
    .orderBy(asc(postTranslations.locale), desc(postTranslations.updatedAt));
}

export type TranslationDraftInput = {
  title: string;
  summary?: string | null;
  body?: string | null;
  source?: "manual" | "machine";
};

function requireSupportedLocale(locale: string): asserts locale is Locale {
  if (!isLocale(locale)) throw new ApiError(400, "unsupportedLocale", { locale });
}

async function requireTranslationTarget(
  postId: string,
  locale: string,
  dbc: DbClient,
): Promise<Post> {
  requireSupportedLocale(locale);
  const [post] = await dbc.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) throw new ApiError(404, "postNotFound");
  if (post.originalLocale === locale) {
    throw new ApiError(400, "translationOriginalLocale", { locale });
  }
  return post;
}

function requireTranslationTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new ApiError(400, "translationTitleRequired");
  return trimmed;
}

export async function upsertDraftTranslation(
  postId: string,
  locale: string,
  input: TranslationDraftInput,
  dbc = getDb(),
): Promise<PostTranslation> {
  return dbc.transaction(async (tx) => {
    const post = await requireTranslationTarget(postId, locale, tx);
    const title = requireTranslationTitle(input.title);
    const [existing] = await tx
      .select()
      .from(postTranslations)
      .where(
        and(
          eq(postTranslations.postId, postId),
          eq(postTranslations.locale, locale),
          eq(postTranslations.status, "draft"),
        ),
      )
      .orderBy(desc(postTranslations.updatedAt))
      .limit(1);
    const values = {
      title,
      summary: input.summary ?? null,
      body: input.body ?? null,
      source: input.source ?? "manual",
      sourceUpdatedAt: post.updatedAt,
      updatedAt: new Date(),
    } as const;

    if (existing) {
      const [updated] = await tx
        .update(postTranslations)
        .set(values)
        .where(eq(postTranslations.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await tx
      .insert(postTranslations)
      .values({ postId, locale, ...values })
      .returning();
    return created;
  });
}

export async function publishTranslation(
  postId: string,
  locale: string,
  dbc = getDb(),
): Promise<PostTranslation> {
  return dbc.transaction(async (tx) => {
    const post = await requireTranslationTarget(postId, locale, tx);
    const [draft] = await tx
      .select()
      .from(postTranslations)
      .where(
        and(
          eq(postTranslations.postId, postId),
          eq(postTranslations.locale, locale),
          eq(postTranslations.status, "draft"),
        ),
      )
      .orderBy(desc(postTranslations.updatedAt))
      .limit(1);
    if (!draft) throw new ApiError(404, "translationDraftNotFound");
    requireTranslationTitle(draft.title);
    if (post.body?.trim() && !draft.body?.trim()) {
      throw new ApiError(400, "translationBodyRequired");
    }

    const now = new Date();
    await tx
      .update(postTranslations)
      .set({ status: "archived", updatedAt: now })
      .where(
        and(
          eq(postTranslations.postId, postId),
          eq(postTranslations.locale, locale),
          eq(postTranslations.status, "published"),
        ),
      );
    const [published] = await tx
      .update(postTranslations)
      .set({ status: "published", publishedAt: now, updatedAt: now })
      .where(and(eq(postTranslations.id, draft.id), eq(postTranslations.status, "draft")))
      .returning();
    if (!published) throw new ApiError(404, "translationDraftNotFound");
    return published;
  });
}

export async function unpublishTranslation(
  postId: string,
  locale: string,
  dbc: DbClient = getDb(),
): Promise<void> {
  await requireTranslationTarget(postId, locale, dbc);
  await dbc
    .update(postTranslations)
    .set({ status: "archived", updatedAt: new Date() })
    .where(
      and(
        eq(postTranslations.postId, postId),
        eq(postTranslations.locale, locale),
        eq(postTranslations.status, "published"),
      ),
    );
}

export async function deleteTranslation(
  translationId: string,
  dbc: DbClient = getDb(),
): Promise<void> {
  await dbc.delete(postTranslations).where(eq(postTranslations.id, translationId));
}

export async function deleteDraftTranslation(
  postId: string,
  locale: string,
  dbc: DbClient = getDb(),
): Promise<void> {
  await requireTranslationTarget(postId, locale, dbc);
  await dbc
    .delete(postTranslations)
    .where(
      and(
        eq(postTranslations.postId, postId),
        eq(postTranslations.locale, locale),
        eq(postTranslations.status, "draft"),
      ),
    );
}

/** 用户是否可访问内容（admin 直通；published 状态由调用方决定是否要求） */
export async function canAccessPost(user: User | null, post: Post): Promise<boolean> {
  if (user?.role === "admin") return true;
  if (post.visibility === "public") return true;
  if (!user) return false;
  if (post.visibility === "login") return true;
  // member 内容
  if (!post.requiredTierId) return false;
  const [requiredTier] = await getDb()
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.id, post.requiredTierId))
    .limit(1);
  if (!requiredTier) return false;
  const activeLevel = await getActiveLevel(user.id);
  return activeLevel >= requiredTier.level;
}

export async function getRequiredTier(post: Post): Promise<MembershipTier | null> {
  if (!post.requiredTierId) return null;
  const [tier] = await getDb()
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.id, post.requiredTierId))
    .limit(1);
  return tier ?? null;
}

export type PostFileWithFile = { link: PostFile; file: FileRecord };

export async function listPostFiles(postId: string): Promise<PostFileWithFile[]> {
  return getDb()
    .select({ link: postFiles, file: files })
    .from(postFiles)
    .innerJoin(files, eq(postFiles.fileId, files.id))
    .where(eq(postFiles.postId, postId))
    .orderBy(asc(postFiles.sortOrder), asc(postFiles.createdAt));
}

export async function attachFileToPost(input: {
  postId: string;
  fileId: string;
  kind: PostFile["kind"];
  sortOrder?: number;
}): Promise<PostFile> {
  const [link] = await getDb()
    .insert(postFiles)
    .values({ ...input, sortOrder: input.sortOrder ?? 0 })
    .returning();
  return link;
}

export async function detachFileFromPost(postId: string, fileId: string): Promise<void> {
  await getDb()
    .delete(postFiles)
    .where(and(eq(postFiles.postId, postId), eq(postFiles.fileId, fileId)));
}

/** 文件所关联的 posts（用于下载鉴权） */
export async function listPostsForFile(fileId: string): Promise<Post[]> {
  const rows = await getDb()
    .select({ post: posts })
    .from(postFiles)
    .innerJoin(posts, eq(postFiles.postId, posts.id))
    .where(eq(postFiles.fileId, fileId));
  return rows.map((r) => r.post);
}
