import { sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { DEFAULT_LOCALE } from "@/modules/i18n";
import { readPublicSiteInfoWithMetadata } from "@/modules/site";

import {
  buildPostUrl,
  buildPublicHttpResource,
  buildPublicUrl,
  countPublicPosts,
  countPublicSitemapPostShards,
  escapeXml,
  getPublicBaseUrl,
  listPublicSitemapShard,
  maxPublicDate,
  PUBLIC_EMPTY_LAST_MODIFIED,
  PUBLIC_SITEMAP_URL_LIMIT,
  type PublicHttpResource,
  type PublicPostProjectionRow,
  toDate,
} from "./public-projection";

export const PUBLIC_SITEMAP_CONTENT_TYPE = "application/xml; charset=utf-8";
export const PUBLIC_ROBOTS_CONTENT_TYPE = "text/plain; charset=utf-8";
export const STATIC_SITEMAP_PATHS = ["/", "/posts", "/tiers"] as const;

export type SitemapEntry = {
  loc: string;
  lastmod?: Date | null;
};

function renderXmlDate(date: Date): string {
  return date.toISOString();
}

export function renderSitemapIndex(entries: SitemapEntry[]): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const entry of entries) {
    lines.push("  <sitemap>");
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
    if (entry.lastmod) lines.push(`    <lastmod>${renderXmlDate(entry.lastmod)}</lastmod>`);
    lines.push("  </sitemap>");
  }
  lines.push("</sitemapindex>");
  return `${lines.join("\n")}\n`;
}

export function renderSitemapUrlSet(entries: SitemapEntry[]): string {
  if (entries.length > PUBLIC_SITEMAP_URL_LIMIT) {
    throw new Error("sitemap urlset cannot exceed 50,000 URLs");
  }
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const entry of entries) {
    lines.push("  <url>");
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
    if (entry.lastmod) lines.push(`    <lastmod>${renderXmlDate(entry.lastmod)}</lastmod>`);
    lines.push("  </url>");
  }
  lines.push("</urlset>");
  return `${lines.join("\n")}\n`;
}

export async function readPublicPostSitemapLastModified(
  dbc: DbClient = getDb(),
): Promise<Date | null> {
  const [row] = await dbc.execute<{ lastModifiedAt: Date | string | null }>(sql`
    select max(greatest(
      posts.published_at,
      posts.updated_at,
      posts.content_updated_at,
      coalesce(post_translations.updated_at, posts.published_at),
      coalesce(post_translations.published_at, posts.published_at)
    )) as "lastModifiedAt"
    from posts
    left join post_translations
      on post_translations.post_id = posts.id
      and post_translations.locale = ${DEFAULT_LOCALE}
      and post_translations.status = 'published'
    where posts.status = 'published'
      and posts.visibility = 'public'
      and posts.published_at is not null
  `);
  return toDate(row?.lastModifiedAt);
}

export async function buildSitemapIndexResource(
  opts: {
    baseUrl?: string;
    shardSize?: number;
    dbc?: DbClient;
  } = {},
): Promise<PublicHttpResource> {
  const baseUrl = opts.baseUrl ?? getPublicBaseUrl();
  const dbc = opts.dbc ?? getDb();
  const [site, postCount, latestPostUpdatedAt] = await Promise.all([
    readPublicSiteInfoWithMetadata(),
    countPublicPosts(dbc),
    readPublicPostSitemapLastModified(dbc),
  ]);
  const postShardCount = Math.max(
    1,
    countPublicSitemapPostShards(postCount, opts.shardSize ?? PUBLIC_SITEMAP_URL_LIMIT),
  );
  // Known accepted limitation (same ruling as the feed): derived from rows
  // still in the public projection, so removals can move it backward and an
  // If-Modified-Since-only client may briefly get a stale 304. The strong
  // ETag is the authoritative validator and If-None-Match takes precedence.
  const lastModifiedAt = maxPublicDate(site.feedIdentityUpdatedAt, latestPostUpdatedAt);
  const entries: SitemapEntry[] = [
    {
      loc: buildPublicUrl(baseUrl, "/sitemaps/static.xml"),
      lastmod: site.feedIdentityUpdatedAt ?? lastModifiedAt,
    },
    ...Array.from({ length: postShardCount }, (_, shard) => ({
      loc: buildPublicUrl(baseUrl, `/sitemaps/posts/${shard}.xml`),
      lastmod: latestPostUpdatedAt ?? lastModifiedAt,
    })),
  ];
  return buildPublicHttpResource(renderSitemapIndex(entries), lastModifiedAt);
}

export async function buildStaticSitemapResource(
  opts: {
    baseUrl?: string;
  } = {},
): Promise<PublicHttpResource> {
  const baseUrl = opts.baseUrl ?? getPublicBaseUrl();
  const site = await readPublicSiteInfoWithMetadata();
  const lastModifiedAt = site.feedIdentityUpdatedAt ?? PUBLIC_EMPTY_LAST_MODIFIED;
  const entries = STATIC_SITEMAP_PATHS.map((path) => ({
    loc: buildPublicUrl(baseUrl, path),
    lastmod: site.feedIdentityUpdatedAt,
  }));
  return buildPublicHttpResource(renderSitemapUrlSet(entries), lastModifiedAt);
}

export async function buildPostSitemapShardResource(opts: {
  shard: number;
  baseUrl?: string;
  shardSize?: number;
  dbc?: DbClient;
}): Promise<PublicHttpResource | null> {
  const baseUrl = opts.baseUrl ?? getPublicBaseUrl();
  const dbc = opts.dbc ?? getDb();
  const postCount = await countPublicPosts(dbc);
  const shardCount = Math.max(
    1,
    countPublicSitemapPostShards(postCount, opts.shardSize ?? PUBLIC_SITEMAP_URL_LIMIT),
  );
  if (opts.shard < 0 || opts.shard >= shardCount) return null;
  const posts = await listPublicSitemapShard({
    shard: opts.shard,
    shardSize: opts.shardSize,
    dbc,
  });
  const entries = posts.map((post: PublicPostProjectionRow) => ({
    loc: buildPostUrl(baseUrl, post.slug),
    lastmod: post.updatedAt,
  }));
  return buildPublicHttpResource(
    renderSitemapUrlSet(entries),
    maxPublicDate(...posts.map((post) => post.updatedAt)),
  );
}

const ROBOTS_DISALLOW_PATHS = [
  "/admin/",
  "/api/",
  "/download/",
  "/me/",
  "/checkout/",
  "/login",
] as const;

export function buildRobotsTxt(baseUrl = getPublicBaseUrl()): PublicHttpResource {
  // Robots directives match the full request path, so a base-path deployment
  // (APP_URL like https://site.example/base) must disallow /base/admin/ etc.
  const basePath = new URL(`${baseUrl}/`).pathname.replace(/\/+$/, "");
  const body = [
    "User-agent: *",
    `Allow: ${basePath || "/"}${basePath ? "/" : ""}`,
    ...ROBOTS_DISALLOW_PATHS.map((path) => `Disallow: ${basePath}${path}`),
    `Sitemap: ${buildPublicUrl(baseUrl, "/sitemap.xml")}`,
    "",
  ].join("\n");
  return buildPublicHttpResource(body, PUBLIC_EMPTY_LAST_MODIFIED);
}
