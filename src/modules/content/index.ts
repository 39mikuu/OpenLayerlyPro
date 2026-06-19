import { and, asc, desc, eq, exists, getTableColumns, inArray, lt, or, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import {
  categories,
  type FileRecord,
  files,
  type MembershipTier,
  membershipTiers,
  type Post,
  postCategories,
  type PostFile,
  postFiles,
  posts,
  postTags,
  type PostTranslation,
  postTranslations,
  tags,
  type User,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { isLocale, type Locale } from "@/modules/i18n";
import { getActiveLevel } from "@/modules/membership";
import { setPostCategories, setPostTags } from "@/modules/taxonomy";

export type PostInput = {
  title: string;
  slug: string;
  summary?: string | null;
  body?: string | null;
  originalLocale?: string;
  coverFileId?: string | null;
  visibility: "public" | "login" | "member";
  requiredTierId?: string | null;
};

export type PostTaxonomyInput = {
  categoryIds?: string[];
  tagIds?: string[];
};

export async function createPost(
  input: PostInput,
  taxonomy: PostTaxonomyInput = {},
): Promise<Post> {
  await assertValidTier(input);
  return getDb().transaction(async (tx) => {
    const [post] = await tx
      .insert(posts)
      .values({ ...input, status: "draft" })
      .returning();
    if (taxonomy.categoryIds !== undefined) {
      await setPostCategories(post.id, taxonomy.categoryIds, tx);
    }
    if (taxonomy.tagIds !== undefined) await setPostTags(post.id, taxonomy.tagIds, tx);
    return post;
  });
}

export async function updatePost(
  id: string,
  input: Partial<PostInput>,
  taxonomy: PostTaxonomyInput = {},
): Promise<Post> {
  return getDb().transaction(async (tx) => {
    const [existing] = await tx.select().from(posts).where(eq(posts.id, id)).limit(1).for("update");
    if (!existing) throw new ApiError(404, "postNotFound");
    if (existing.status !== "draft") throw new ApiError(409, "postNotEditable");

    if (input.visibility === "member" || input.requiredTierId !== undefined) {
      await assertValidTier({
        visibility: input.visibility ?? existing.visibility,
        requiredTierId:
          input.requiredTierId !== undefined ? input.requiredTierId : existing.requiredTierId,
      });
    }

    const contentChanged =
      (input.title !== undefined && input.title !== existing.title) ||
      (input.summary !== undefined && input.summary !== existing.summary) ||
      (input.body !== undefined && input.body !== existing.body) ||
      (input.originalLocale !== undefined && input.originalLocale !== existing.originalLocale);
    const [post] = await tx
      .update(posts)
      .set({
        ...input,
        updatedAt: sql`now()`,
        ...(contentChanged ? { contentUpdatedAt: sql`now()` } : {}),
      })
      .where(and(eq(posts.id, id), eq(posts.status, "draft")))
      .returning();
    if (!post) throw new ApiError(409, "postNotEditable");
    if (taxonomy.categoryIds !== undefined) {
      await setPostCategories(id, taxonomy.categoryIds, tx);
    }
    if (taxonomy.tagIds !== undefined) await setPostTags(id, taxonomy.tagIds, tx);
    return post;
  });
}

async function assertValidTier(input: {
  visibility: string;
  requiredTierId?: string | null;
}): Promise<void> {
  if (input.visibility === "member" && !input.requiredTierId) {
    throw new ApiError(400, "memberTierRequired");
  }
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

export async function getPublishedPostBySlug(slug: string): Promise<Post | null> {
  const [post] = await getDb()
    .select()
    .from(posts)
    .where(and(eq(posts.slug, slug), eq(posts.status, "published")))
    .limit(1);
  return post ?? null;
}

function taxonomyFilterConditions(opts?: { categorySlug?: string; tagSlug?: string }) {
  const db = getDb();
  return [
    ...(opts?.categorySlug
      ? [
          exists(
            db
              .select({ value: sql`1` })
              .from(postCategories)
              .innerJoin(categories, eq(postCategories.categoryId, categories.id))
              .where(
                and(eq(postCategories.postId, posts.id), eq(categories.slug, opts.categorySlug)),
              ),
          ),
        ]
      : []),
    ...(opts?.tagSlug
      ? [
          exists(
            db
              .select({ value: sql`1` })
              .from(postTags)
              .innerJoin(tags, eq(postTags.tagId, tags.id))
              .where(and(eq(postTags.postId, posts.id), eq(tags.slug, opts.tagSlug))),
          ),
        ]
      : []),
  ];
}

export async function listPosts(opts?: {
  publishedOnly?: boolean;
  categorySlug?: string;
  tagSlug?: string;
}): Promise<Post[]> {
  const db = getDb();
  const conditions = [
    ...(opts?.publishedOnly ? [eq(posts.status, "published")] : []),
    ...taxonomyFilterConditions(opts),
  ];
  const query = db.select().from(posts);
  const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;
  return filtered.orderBy(opts?.publishedOnly ? desc(posts.publishedAt) : desc(posts.createdAt));
}

export const POSTS_PAGE_SIZE = 12;

export type PostCursor = { publishedAt: string; id: string };

const PRECISE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function maxDayOfMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function isPreciseUtcTimestamp(value: string): boolean {
  const match = PRECISE_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= maxDayOfMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

export function encodeCursor(cursor: PostCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string | null | undefined): PostCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<PostCursor>;
    if (
      typeof parsed.publishedAt !== "string" ||
      !isPreciseUtcTimestamp(parsed.publishedAt) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      return null;
    }
    return { publishedAt: parsed.publishedAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function listPublishedPostsPage(opts: {
  limit?: number;
  cursor?: string | null;
  categorySlug?: string;
  tagSlug?: string;
}): Promise<{ posts: Post[]; nextCursor: string | null }> {
  const db = getDb();
  const requestedLimit = opts.limit ?? POSTS_PAGE_SIZE;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), 100))
    : POSTS_PAGE_SIZE;
  const cursor = decodeCursor(opts.cursor);
  const precisePublishedAt = sql<string>`to_char(
    ${posts.publishedAt} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`;
  const conditions = [
    eq(posts.status, "published"),
    ...taxonomyFilterConditions(opts),
    ...(cursor
      ? [
          or(
            lt(posts.publishedAt, sql`${cursor.publishedAt}::timestamptz`),
            and(
              eq(posts.publishedAt, sql`${cursor.publishedAt}::timestamptz`),
              lt(posts.id, cursor.id),
            ),
          )!,
        ]
      : []),
  ];
  const rows = await db
    .select({
      ...getTableColumns(posts),
      cursorPublishedAt: precisePublishedAt,
    })
    .from(posts)
    .where(and(...conditions))
    .orderBy(desc(posts.publishedAt), desc(posts.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const pagePosts = pageRows.map(({ cursorPublishedAt, ...post }) => {
    void cursorPublishedAt;
    return post;
  });
  const last = pageRows.at(-1);
  return {
    posts: pagePosts,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ publishedAt: last.cursorPublishedAt, id: last.id })
        : null,
  };
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
      sourceUpdatedAt: post.contentUpdatedAt,
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
  return getDb().transaction(async (tx) => {
    const [post] = await tx
      .select({ id: posts.id, status: posts.status })
      .from(posts)
      .where(eq(posts.id, input.postId))
      .limit(1)
      .for("update");
    if (!post) throw new ApiError(404, "postNotFound");
    if (post.status !== "draft") throw new ApiError(409, "postNotEditable");

    const [link] = await tx
      .insert(postFiles)
      .values({ ...input, sortOrder: input.sortOrder ?? 0 })
      .returning();
    return link;
  });
}

export async function detachFileFromPost(postId: string, fileId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [post] = await tx
      .select({ id: posts.id, status: posts.status })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1)
      .for("update");
    if (!post) throw new ApiError(404, "postNotFound");
    if (post.status !== "draft") throw new ApiError(409, "postNotEditable");

    await tx
      .delete(postFiles)
      .where(and(eq(postFiles.postId, postId), eq(postFiles.fileId, fileId)));
  });
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

export type { DerivedPostState, PublishingActor, ScheduledPublishResult } from "./publishing";
export {
  archivePost,
  cancelPostSchedule,
  derivePostState,
  executeScheduledPublish,
  publishPostNow,
  reschedulePost,
  restorePost,
  schedulePost,
} from "./publishing";
