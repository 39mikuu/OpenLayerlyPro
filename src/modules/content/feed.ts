import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { DEFAULT_LOCALE } from "@/modules/i18n/config";
import { readPublicSiteInfoWithMetadata } from "@/modules/site";

import {
  buildPostUrl,
  buildPublicUrl,
  escapeXml,
  getPublicBaseUrl,
  isPublicHttpResourceNotModified,
  maxPublicDate,
  PUBLIC_EMPTY_LAST_MODIFIED,
  PUBLIC_SEO_CACHE_CONTROL,
  publicXmlHeaders,
  sanitizeXml10,
  toDate,
  trimPublicSummary,
} from "./public-projection";

export const PUBLIC_ATOM_FEED_LIMIT = 100;
export const PUBLIC_ATOM_CACHE_CONTROL = PUBLIC_SEO_CACHE_CONTROL;
export const PUBLIC_ATOM_CONTENT_TYPE = "application/atom+xml; charset=utf-8";
export const PUBLIC_ATOM_EMPTY_LAST_MODIFIED = PUBLIC_EMPTY_LAST_MODIFIED;

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

export function getFeedBaseUrl(appUrl?: string): string {
  return getPublicBaseUrl(appUrl);
}

export function buildPostGuid(postId: string): string {
  const digest = createHash("sha256")
    .update(`openlayerlypro-post-guid-v1:${postId}`)
    .digest("base64url");
  return `urn:openlayerlypro:post:v1:${digest}`;
}

const buildFeedPath = buildPublicUrl;

export function buildPostFeedUrl(baseUrl: string, slug: string): string {
  return buildPostUrl(baseUrl, slug);
}

export { escapeXml, sanitizeXml10 };

const maxDate = maxPublicDate;
const trimSummary = trimPublicSummary;

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
  identityUpdatedAt?: Date | null;
}): string {
  const feedUrl = buildFeedPath(input.baseUrl, "/feed.xml");
  const homeUrl = buildFeedPath(input.baseUrl, "/");
  const feedUpdatedAt = maxDate(
    input.identityUpdatedAt,
    ...input.entries.map((entry) => entry.updatedAt),
  );
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
    identityUpdatedAt: site.feedIdentityUpdatedAt,
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

// Unlike the sitemap/robots collections (ETag-only), the feed keeps its WP3
// contract: Last-Modified is advertised and If-Modified-Since is honored with
// precise-ms comparison, with If-None-Match always taking precedence.
export function isPublicAtomFeedNotModified(headers: Headers, feed: PublicAtomFeed): boolean {
  if (headers.get("if-none-match")) {
    return isPublicHttpResourceNotModified(headers, { body: feed.xml, etag: feed.etag });
  }
  const ifModifiedSince = headers.get("if-modified-since");
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  if (!Number.isFinite(since)) return false;
  return since >= feed.lastModifiedAt.getTime();
}

export function publicAtomFeedHeaders(feed: PublicAtomFeed): Headers {
  const headers = publicXmlHeaders({ body: feed.xml, etag: feed.etag }, PUBLIC_ATOM_CONTENT_TYPE);
  headers.set("last-modified", feed.lastModified);
  return headers;
}
