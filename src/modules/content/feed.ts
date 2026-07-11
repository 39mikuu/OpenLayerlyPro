import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { getEnv } from "@/lib/env";
import { DEFAULT_LOCALE } from "@/modules/i18n/config";
import { readPublicSiteInfoWithMetadata } from "@/modules/site";

export const PUBLIC_ATOM_FEED_LIMIT = 100;
export const PUBLIC_ATOM_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=60";
export const PUBLIC_ATOM_CONTENT_TYPE = "application/atom+xml; charset=utf-8";
export const PUBLIC_ATOM_EMPTY_LAST_MODIFIED = new Date(0);

type PublicFeedRow = {
  id: string;
  slug: string;
  publishedAt: Date | string;
  postUpdatedAt: Date | string;
  contentUpdatedAt: Date | string;
  originalLocale: string;
  originalTitle: string;
  originalSummary: string | null;
  translationId: string | null;
  translationTitle: string | null;
  translationSummary: string | null;
  translationUpdatedAt: Date | string | null;
  translationPublishedAt: Date | string | null;
};

export const PUBLIC_ATOM_FEED_SQL = sql<PublicFeedRow>`
  select
    feed_posts.id,
    feed_posts.slug,
    feed_posts.published_at as "publishedAt",
    feed_posts.updated_at as "postUpdatedAt",
    feed_posts.content_updated_at as "contentUpdatedAt",
    feed_posts.original_locale as "originalLocale",
    feed_posts.title as "originalTitle",
    feed_posts.summary as "originalSummary",
    post_translations.id as "translationId",
    post_translations.title as "translationTitle",
    post_translations.summary as "translationSummary",
    post_translations.updated_at as "translationUpdatedAt",
    post_translations.published_at as "translationPublishedAt"
  from (
    select
      posts.id,
      posts.slug,
      posts.published_at,
      posts.updated_at,
      posts.content_updated_at,
      posts.original_locale,
      posts.title,
      posts.summary
    from posts
    where posts.status = 'published'
      and posts.visibility = 'public'
      and posts.published_at is not null
    order by posts.published_at desc, posts.id desc
    limit ${PUBLIC_ATOM_FEED_LIMIT}
  ) feed_posts
  left join post_translations
    on post_translations.post_id = feed_posts.id
    and post_translations.locale = ${DEFAULT_LOCALE}
    and post_translations.status = 'published'
  order by feed_posts.published_at desc, feed_posts.id desc
`;

export function publicAtomFeedSqlText(): string {
  return PUBLIC_ATOM_FEED_SQL.queryChunks
    .flatMap((chunk) => {
      if (typeof chunk === "string") return [chunk];
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value: unknown }).value;
        if (typeof value === "string") return [value];
        if (Array.isArray(value)) {
          return value.filter((part): part is string => typeof part === "string");
        }
      }
      return [];
    })
    .join("");
}

export type PublicAtomFeedEntry = {
  id: string;
  guid: string;
  title: string;
  slug: string;
  summary: string | null;
  publishedAt: Date;
  updatedAt: Date;
};

export type PublicAtomFeed = {
  xml: string;
  etag: string;
  lastModifiedAt: Date;
  lastModified: string;
};

export function getFeedBaseUrl(appUrl = getEnv().APP_URL): string {
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    throw new Error("APP_URL must be an absolute http(s) URL for /feed.xml");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("APP_URL must use http or https for /feed.xml");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("APP_URL must not include query or hash for /feed.xml");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

export function buildPostGuid(postId: string): string {
  const digest = createHash("sha256")
    .update(`openlayerlypro-post-guid-v1:${postId}`)
    .digest("base64url");
  return `urn:openlayerlypro:post:v1:${digest}`;
}

function buildFeedPath(baseUrl: string, path: string): string {
  const parsed = new URL(`${baseUrl}/`);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath}${path}`;
  return parsed.toString();
}

export function buildPostFeedUrl(baseUrl: string, slug: string): string {
  return buildFeedPath(baseUrl, `/posts/${encodeURIComponent(slug)}`);
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

// Raw sql`` rows come back from postgres.js without drizzle's column mappers,
// so timestamp columns arrive as strings and must be coerced here.
function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function maxDate(...dates: Array<Date | null | undefined>): Date {
  return dates.reduce<Date>((max, date) => {
    if (!date) return max;
    return date.getTime() > max.getTime() ? date : max;
  }, PUBLIC_ATOM_EMPTY_LAST_MODIFIED);
}

function trimSummary(summary: string | null): string | null {
  const trimmed = summary?.trim();
  return trimmed ? trimmed : null;
}

function rowToFeedEntry(row: PublicFeedRow): PublicAtomFeedEntry {
  const hasTranslation = row.translationId !== null;
  const publishedAt = toDate(row.publishedAt);
  if (!publishedAt) {
    throw new Error("public feed row is missing published_at");
  }
  const updatedAt = maxDate(
    publishedAt,
    toDate(row.contentUpdatedAt),
    toDate(row.postUpdatedAt),
    toDate(row.translationUpdatedAt),
    toDate(row.translationPublishedAt),
  );
  return {
    id: row.id,
    guid: buildPostGuid(row.id),
    title: hasTranslation && row.translationTitle ? row.translationTitle : row.originalTitle,
    slug: row.slug,
    summary: trimSummary(
      hasTranslation ? (row.translationSummary ?? null) : (row.originalSummary ?? null),
    ),
    publishedAt,
    updatedAt,
  };
}

export async function listPublicAtomFeedEntries(
  dbc: DbClient = getDb(),
): Promise<PublicAtomFeedEntry[]> {
  const rows = (await dbc.execute(PUBLIC_ATOM_FEED_SQL)) as PublicFeedRow[];
  return rows.map(rowToFeedEntry);
}

export function renderPublicAtomFeed(input: {
  baseUrl: string;
  siteName: string;
  authorName: string;
  entries: PublicAtomFeedEntry[];
}): string {
  const feedUrl = buildFeedPath(input.baseUrl, "/feed.xml");
  const homeUrl = buildFeedPath(input.baseUrl, "/");
  const feedUpdatedAt = maxDate(...input.entries.map((entry) => entry.updatedAt));
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(feedUrl)}</id>`,
    `  <title>${escapeXml(input.siteName)}</title>`,
    `  <author><name>${escapeXml(input.authorName)}</name></author>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}"/>`,
    `  <link rel="alternate" href="${escapeXml(homeUrl)}"/>`,
    `  <updated>${feedUpdatedAt.toISOString()}</updated>`,
  ];
  for (const entry of input.entries) {
    lines.push("  <entry>");
    lines.push(`    <id>${escapeXml(entry.guid)}</id>`);
    lines.push(`    <title>${escapeXml(entry.title)}</title>`);
    lines.push(
      `    <link rel="alternate" href="${escapeXml(buildPostFeedUrl(input.baseUrl, entry.slug))}"/>`,
    );
    lines.push(`    <published>${entry.publishedAt.toISOString()}</published>`);
    lines.push(`    <updated>${entry.updatedAt.toISOString()}</updated>`);
    if (entry.summary) {
      lines.push(`    <summary type="text">${escapeXml(entry.summary)}</summary>`);
    }
    lines.push("  </entry>");
  }
  lines.push("</feed>");
  return `${lines.join("\n")}\n`;
}

export function buildFeedMetadata(xml: string, lastModifiedAt: Date): PublicAtomFeed {
  return {
    xml,
    etag: `"${createHash("sha256").update(xml).digest("base64url")}"`,
    lastModifiedAt,
    lastModified: lastModifiedAt.toUTCString(),
  };
}

export async function buildPublicAtomFeed(dbc: DbClient = getDb()): Promise<PublicAtomFeed> {
  const [site, entries] = await Promise.all([
    readPublicSiteInfoWithMetadata(),
    listPublicAtomFeedEntries(dbc),
  ]);
  const baseUrl = getFeedBaseUrl();
  const xml = renderPublicAtomFeed({
    baseUrl,
    siteName: site.siteName,
    authorName: site.artistName || site.siteName || "Artist Member Site",
    entries,
  });
  // Known accepted limitation: this is derived only from rows still visible in
  // the feed, so removing an entry (unpublish, visibility change, translation
  // archival) can move it backward and an If-Modified-Since-only client may
  // briefly get a stale 304. The strong ETag is the authoritative validator
  // and If-None-Match always takes precedence below.
  const lastModifiedAt = maxDate(
    site.feedIdentityUpdatedAt,
    ...entries.map((entry) => entry.updatedAt),
  );
  return buildFeedMetadata(xml, lastModifiedAt);
}

export function isPublicAtomFeedNotModified(headers: Headers, feed: PublicAtomFeed): boolean {
  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch) {
    // RFC 9110 §13.1.2: If-None-Match uses weak comparison for GET, and "*"
    // matches any existing representation.
    if (ifNoneMatch.trim() === "*") return true;
    return ifNoneMatch
      .split(",")
      .map((value) => value.trim().replace(/^W\//, ""))
      .includes(feed.etag);
  }

  const ifModifiedSince = headers.get("if-modified-since");
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  if (!Number.isFinite(since)) return false;
  return since >= feed.lastModifiedAt.getTime();
}

export function publicAtomFeedHeaders(feed: PublicAtomFeed): Headers {
  return new Headers({
    "content-type": PUBLIC_ATOM_CONTENT_TYPE,
    "cache-control": PUBLIC_ATOM_CACHE_CONTROL,
    etag: feed.etag,
    "last-modified": feed.lastModified,
    "x-content-type-options": "nosniff",
  });
}
