import { createHash } from "node:crypto";

import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { posts, postTranslations } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/modules/i18n";

export const PUBLIC_SEO_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=60";
export const PUBLIC_SITEMAP_URL_LIMIT = 50_000;
export const PUBLIC_SITEMAP_SHARD_SIZE = 5_000;
export const PUBLIC_SITEMAP_MAX_SHARDS = 100;
export const PUBLIC_EMPTY_LAST_MODIFIED = new Date(0);

const PRECISE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const UUID_SEGMENT_LENGTHS = [8, 4, 4, 4, 12] as const;

export type PublicPostCursor = { publishedAt: string; id: string };

export type PublicPostProjectionRow = {
  id: string;
  slug: string;
  publishedAt: Date;
  updatedAt: Date;
  title: string;
  summary: string | null;
  coverFileId: string | null;
  contentLocale: Locale;
};

export type PublicSitemapPostRow = {
  id: string;
  slug: string;
  publishedAt: Date;
  updatedAt: Date;
};

export type PublicHttpResource = {
  body: string;
  etag: string;
};

type PublicProjectionSqlRow = {
  id: string;
  slug: string;
  publishedAt: Date | string | null;
  postUpdatedAt: Date | string;
  contentUpdatedAt: Date | string;
  originalLocale: string;
  originalTitle: string;
  originalSummary: string | null;
  coverFileId: string | null;
  translationId: string | null;
  translationTitle: string | null;
  translationSummary: string | null;
  translationLocale: string | null;
  translationUpdatedAt: Date | string | null;
  translationPublishedAt: Date | string | null;
  cursorPublishedAt: string;
};

type PublicSitemapSqlRow = {
  id: string;
  slug: string;
  publishedAt: Date | string | null;
  sitemapUpdatedAt: Date | string;
};

type PublicSitemapBoundarySqlRow = {
  id: string;
  cursorPublishedAt: string;
};

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

function isCanonicalUuidText(value: string): boolean {
  const segments = value.split("-");
  if (segments.length !== UUID_SEGMENT_LENGTHS.length) return false;
  return segments.every((segment, index) => {
    if (segment.length !== UUID_SEGMENT_LENGTHS[index]) return false;
    for (const char of segment) {
      const code = char.charCodeAt(0);
      const isDigit = code >= 48 && code <= 57;
      const isLowerHex = code >= 97 && code <= 102;
      const isUpperHex = code >= 65 && code <= 70;
      if (!isDigit && !isLowerHex && !isUpperHex) return false;
    }
    return true;
  });
}

export function encodePublicPostCursor(cursor: PublicPostCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePublicPostCursor(value: string | null | undefined): PublicPostCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<PublicPostCursor>;
    if (
      typeof parsed.publishedAt !== "string" ||
      !isPreciseUtcTimestamp(parsed.publishedAt) ||
      typeof parsed.id !== "string" ||
      !isCanonicalUuidText(parsed.id)
    ) {
      return null;
    }
    return { publishedAt: parsed.publishedAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function getPublicBaseUrl(appUrl = getEnv().APP_URL): string {
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    throw new Error("APP_URL must be an absolute http(s) URL for public content routes");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("APP_URL must use http or https for public content routes");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("APP_URL must not include query or hash for public content routes");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

export function getPublicSeoRootUrl(appUrl = getEnv().APP_URL): string {
  const baseUrl = getPublicBaseUrl(appUrl);
  if (new URL(`${baseUrl}/`).pathname !== "/") {
    throw new Error("APP_URL must not include a pathname for sitemap and robots routes");
  }
  return baseUrl;
}

export function buildPublicUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("/")) throw new Error("public URL path must start with /");
  const parsed = new URL(`${baseUrl}/`);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath}${path}`;
  return parsed.toString();
}

export function buildPostUrl(baseUrl: string, slug: string): string {
  return buildPublicUrl(baseUrl, `/posts/${encodeURIComponent(slug)}`);
}

export function buildFileUrl(baseUrl: string, fileId: string): string {
  return buildPublicUrl(baseUrl, `/api/files/${encodeURIComponent(fileId)}/download`);
}

function isXml10CodeUnitAllowed(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd)
  );
}

export function sanitizeXml10(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (isXml10CodeUnitAllowed(code)) output += value[index];
  }
  return output;
}

export function escapeXml(value: string): string {
  return sanitizeXml10(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

export function maxPublicDate(...dates: Array<Date | null | undefined>): Date {
  return dates.reduce<Date>((max, date) => {
    if (!date) return max;
    return date.getTime() > max.getTime() ? date : max;
  }, PUBLIC_EMPTY_LAST_MODIFIED);
}

export function trimPublicSummary(summary: string | null): string | null {
  const trimmed = summary?.trim();
  return trimmed ? trimmed : null;
}

function localeOrDefault(value: string | null | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

function rowToProjection(row: PublicProjectionSqlRow): PublicPostProjectionRow {
  const hasTranslation = row.translationId !== null;
  const publishedAt = toDate(row.publishedAt);
  if (!publishedAt) {
    throw new Error("public projection row is missing published_at");
  }
  return {
    id: row.id,
    slug: row.slug,
    publishedAt,
    updatedAt: maxPublicDate(
      publishedAt,
      toDate(row.contentUpdatedAt),
      toDate(row.postUpdatedAt),
      toDate(row.translationUpdatedAt),
      toDate(row.translationPublishedAt),
    ),
    title: hasTranslation && row.translationTitle ? row.translationTitle : row.originalTitle,
    summary: trimPublicSummary(
      hasTranslation ? (row.translationSummary ?? null) : (row.originalSummary ?? null),
    ),
    coverFileId: row.coverFileId,
    contentLocale: hasTranslation
      ? localeOrDefault(row.translationLocale)
      : localeOrDefault(row.originalLocale),
  };
}

function rowToSitemapPost(row: PublicSitemapSqlRow): PublicSitemapPostRow {
  const publishedAt = toDate(row.publishedAt);
  if (!publishedAt) {
    throw new Error("public sitemap row is missing published_at");
  }
  return {
    id: row.id,
    slug: row.slug,
    publishedAt,
    updatedAt: toDate(row.sitemapUpdatedAt) ?? publishedAt,
  };
}

const precisePublishedAt = sql<string>`to_char(
  ${posts.publishedAt} at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`;

function publicPostCursorCondition(cursor: PublicPostCursor | null) {
  return cursor
    ? or(
        lt(posts.publishedAt, sql`${cursor.publishedAt}::timestamptz`),
        and(
          eq(posts.publishedAt, sql`${cursor.publishedAt}::timestamptz`),
          lt(posts.id, cursor.id),
        ),
      )
    : undefined;
}

function publicPostProjectionConditions(cursor?: PublicPostCursor | null) {
  return [
    eq(posts.status, "published"),
    eq(posts.visibility, "public"),
    sql`${posts.publishedAt} is not null`,
    ...(cursor ? [publicPostCursorCondition(cursor)!] : []),
  ];
}

// Exported unexecuted so integration tests can EXPLAIN the exact query shape
// the sitemap/projection paths run (join and cursor predicate included).
export function publicPostProjectionQuery(opts: {
  limit: number;
  cursor?: PublicPostCursor | null;
  locale?: Locale;
  dbc?: DbClient;
}) {
  const dbc = opts.dbc ?? getDb();
  const locale = opts.locale ?? DEFAULT_LOCALE;
  return dbc
    .select({
      id: posts.id,
      slug: posts.slug,
      publishedAt: posts.publishedAt,
      postUpdatedAt: posts.updatedAt,
      contentUpdatedAt: posts.contentUpdatedAt,
      originalLocale: posts.originalLocale,
      originalTitle: posts.title,
      originalSummary: posts.summary,
      coverFileId: posts.coverFileId,
      translationId: postTranslations.id,
      translationTitle: postTranslations.title,
      translationSummary: postTranslations.summary,
      translationLocale: postTranslations.locale,
      translationUpdatedAt: postTranslations.updatedAt,
      translationPublishedAt: postTranslations.publishedAt,
      cursorPublishedAt: precisePublishedAt,
    })
    .from(posts)
    .leftJoin(
      postTranslations,
      and(
        eq(postTranslations.postId, posts.id),
        eq(postTranslations.locale, locale),
        eq(postTranslations.status, "published"),
      ),
    )
    .where(and(...publicPostProjectionConditions(opts.cursor ?? null)))
    .orderBy(desc(posts.publishedAt), desc(posts.id))
    .limit(opts.limit);
}

function publicSitemapPostSelect() {
  return {
    id: posts.id,
    slug: posts.slug,
    publishedAt: posts.publishedAt,
    sitemapUpdatedAt: sql<Date | string>`greatest(
      ${posts.publishedAt},
      ${posts.updatedAt},
      ${posts.contentUpdatedAt},
      coalesce(${postTranslations.updatedAt}, ${posts.publishedAt}),
      coalesce(${postTranslations.publishedAt}, ${posts.publishedAt})
    )`,
  };
}

export function publicSitemapPostQuery(opts: {
  limit: number;
  cursor?: PublicPostCursor | null;
  locale?: Locale;
  dbc?: DbClient;
}) {
  const dbc = opts.dbc ?? getDb();
  const locale = opts.locale ?? DEFAULT_LOCALE;
  return dbc
    .select(publicSitemapPostSelect())
    .from(posts)
    .leftJoin(
      postTranslations,
      and(
        eq(postTranslations.postId, posts.id),
        eq(postTranslations.locale, locale),
        eq(postTranslations.status, "published"),
      ),
    )
    .where(and(...publicPostProjectionConditions(opts.cursor ?? null)))
    .orderBy(desc(posts.publishedAt), desc(posts.id))
    .limit(opts.limit);
}

export function publicSitemapShardBoundaryPageQuery(opts: {
  limit: number;
  cursor?: PublicPostCursor | null;
  dbc?: DbClient;
}) {
  const dbc = opts.dbc ?? getDb();
  return dbc
    .select({
      id: posts.id,
      cursorPublishedAt: precisePublishedAt,
    })
    .from(posts)
    .where(and(...publicPostProjectionConditions(opts.cursor ?? null)))
    .orderBy(desc(posts.publishedAt), desc(posts.id))
    .limit(opts.limit);
}

async function readPublicSitemapShardBoundary(opts: {
  shard: number;
  shardSize: number;
  dbc?: DbClient;
}): Promise<PublicPostCursor | null> {
  if (opts.shard <= 0) return null;
  if (opts.shard >= PUBLIC_SITEMAP_MAX_SHARDS) return null;

  let cursor: PublicPostCursor | null = null;
  for (let page = 0; page < opts.shard; page += 1) {
    // Capped keyset walk: each step reads one narrow id+publishedAt page via
    // posts_public_feed_idx; 100 shards bounds worst-case work to 500k posts.
    const rows: PublicSitemapBoundarySqlRow[] = await publicSitemapShardBoundaryPageQuery({
      limit: opts.shardSize,
      cursor,
      dbc: opts.dbc,
    });
    if (rows.length < opts.shardSize) return null;
    const boundary = rows.at(-1)!;
    cursor = {
      id: boundary.id,
      publishedAt: boundary.cursorPublishedAt,
    };
  }
  return cursor;
}

async function listPublicPostProjectionRows(opts: {
  limit: number;
  cursor?: PublicPostCursor | null;
  locale?: Locale;
  dbc?: DbClient;
}): Promise<PublicProjectionSqlRow[]> {
  return publicPostProjectionQuery(opts);
}

export async function listPublicPostProjectionPage(opts: {
  limit: number;
  cursor?: string | null;
  locale?: Locale;
  dbc?: DbClient;
}): Promise<{ posts: PublicPostProjectionRow[]; nextCursor: string | null }> {
  const requestedLimit = opts.limit;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), PUBLIC_SITEMAP_URL_LIMIT))
    : PUBLIC_SITEMAP_URL_LIMIT;
  const rows = await listPublicPostProjectionRows({
    limit: limit + 1,
    cursor: decodePublicPostCursor(opts.cursor),
    locale: opts.locale,
    dbc: opts.dbc,
  });
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    posts: pageRows.map(rowToProjection),
    nextCursor:
      rows.length > limit && last
        ? encodePublicPostCursor({ publishedAt: last.cursorPublishedAt, id: last.id })
        : null,
  };
}

export async function countPublicPosts(dbc: DbClient = getDb()): Promise<number> {
  const [row] = await dbc
    .select({ count: sql<number>`count(*)::int` })
    .from(posts)
    .where(and(...publicPostProjectionConditions()));
  return row?.count ?? 0;
}

export function countPublicSitemapPostShards(
  postCount: number,
  shardSize = PUBLIC_SITEMAP_SHARD_SIZE,
): number {
  const safeShardSize = Math.max(1, Math.min(Math.trunc(shardSize), PUBLIC_SITEMAP_URL_LIMIT));
  const shardCount = Math.ceil(Math.max(0, postCount) / safeShardSize);
  if (shardCount > PUBLIC_SITEMAP_MAX_SHARDS) {
    throw new Error("public sitemap shard count exceeds bounded sitemap capacity");
  }
  return shardCount;
}

export async function listPublicSitemapShard(opts: {
  shard: number;
  shardSize?: number;
  locale?: Locale;
  dbc?: DbClient;
}): Promise<PublicSitemapPostRow[]> {
  const shardSize = Math.max(
    1,
    Math.min(Math.trunc(opts.shardSize ?? PUBLIC_SITEMAP_SHARD_SIZE), PUBLIC_SITEMAP_URL_LIMIT),
  );
  const shard = Math.max(0, Math.trunc(opts.shard));
  const cursor = await readPublicSitemapShardBoundary({
    shard,
    shardSize,
    dbc: opts.dbc,
  });
  if (shard > 0 && !cursor) return [];
  const rows = await publicSitemapPostQuery({
    limit: shardSize,
    cursor,
    locale: opts.locale,
    dbc: opts.dbc,
  });
  return rows.map(rowToSitemapPost);
}

export async function getPublicPostProjectionBySlug(
  slug: string,
  dbc: DbClient = getDb(),
): Promise<PublicPostProjectionRow | null> {
  const [row] = await dbc
    .select({
      id: posts.id,
      slug: posts.slug,
      publishedAt: posts.publishedAt,
      postUpdatedAt: posts.updatedAt,
      contentUpdatedAt: posts.contentUpdatedAt,
      originalLocale: posts.originalLocale,
      originalTitle: posts.title,
      originalSummary: posts.summary,
      coverFileId: posts.coverFileId,
      translationId: postTranslations.id,
      translationTitle: postTranslations.title,
      translationSummary: postTranslations.summary,
      translationLocale: postTranslations.locale,
      translationUpdatedAt: postTranslations.updatedAt,
      translationPublishedAt: postTranslations.publishedAt,
      cursorPublishedAt: precisePublishedAt,
    })
    .from(posts)
    .leftJoin(
      postTranslations,
      and(
        eq(postTranslations.postId, posts.id),
        eq(postTranslations.locale, DEFAULT_LOCALE),
        eq(postTranslations.status, "published"),
      ),
    )
    .where(and(...publicPostProjectionConditions(), eq(posts.slug, slug)))
    .limit(1);
  return row ? rowToProjection(row) : null;
}

// Sitemap/robots collections are validated by strong ETag only. A derived
// Last-Modified could move backward when rows leave the public projection,
// letting If-Modified-Since-only clients keep stale 304s — so these routes
// deliberately advertise no Last-Modified and ignore If-Modified-Since.
export function buildPublicHttpResource(body: string): PublicHttpResource {
  return {
    body,
    etag: `"${createHash("sha256").update(body).digest("base64url")}"`,
  };
}

export function isPublicHttpResourceNotModified(
  headers: Headers,
  resource: PublicHttpResource,
): boolean {
  const ifNoneMatch = headers.get("if-none-match");
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .includes(resource.etag);
}

export function publicXmlHeaders(resource: PublicHttpResource, contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": PUBLIC_SEO_CACHE_CONTROL,
    etag: resource.etag,
    "x-content-type-options": "nosniff",
  });
}
