import { sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { membershipTiers } from "@/db/schema";
import { DEFAULT_LOCALE } from "@/modules/i18n";
import { readPublicSiteInfoWithMetadata } from "@/modules/site";

import {
  buildPostUrl,
  buildPublicHttpResource,
  buildPublicUrl,
  countPublicPosts,
  countPublicSitemapPostShards,
  escapeXml,
  getPublicSeoRootUrl,
  listPublicSitemapShard,
  maxPublicDate,
  PUBLIC_SITEMAP_MAX_SHARDS,
  PUBLIC_SITEMAP_SHARD_SIZE,
  PUBLIC_SITEMAP_URL_LIMIT,
  type PublicHttpResource,
  type PublicSitemapPostRow,
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

export async function readPublicTierSitemapLastModified(
  dbc: DbClient = getDb(),
): Promise<Date | null> {
  const [row] = await dbc
    .select({ lastModifiedAt: sql<Date | string | null>`max(${membershipTiers.updatedAt})` })
    .from(membershipTiers);
  return toDate(row?.lastModifiedAt);
}

function maxPublicDateOrNull(...dates: Array<Date | null | undefined>): Date | null {
  return dates.some(Boolean) ? maxPublicDate(...dates) : null;
}

export async function buildSitemapIndexResource(
  opts: {
    baseUrl?: string;
    shardSize?: number;
    dbc?: DbClient;
  } = {},
): Promise<PublicHttpResource> {
  const baseUrl = getPublicSeoRootUrl(opts.baseUrl);
  const dbc = opts.dbc ?? getDb();
  const [site, postCount, latestPostUpdatedAt, latestTierUpdatedAt] = await Promise.all([
    readPublicSiteInfoWithMetadata(),
    countPublicPosts(dbc),
    readPublicPostSitemapLastModified(dbc),
    readPublicTierSitemapLastModified(dbc),
  ]);
  const shardSize = opts.shardSize ?? PUBLIC_SITEMAP_SHARD_SIZE;
  // Zero public posts advertise no post shards: an empty <urlset> is invalid
  // to some sitemap validators, so fresh/private-only sites list static only.
  const postShardCount = countPublicSitemapPostShards(postCount, shardSize);
  // Per-entry <lastmod> below is informational; the HTTP resource itself is
  // validated by strong ETag only (see buildPublicHttpResource).
  const staticLastModifiedAt = maxPublicDateOrNull(
    site.feedIdentityUpdatedAt,
    latestPostUpdatedAt,
    latestTierUpdatedAt,
  );
  const entries: SitemapEntry[] = [
    {
      loc: buildPublicUrl(baseUrl, "/sitemaps/static.xml"),
      lastmod: staticLastModifiedAt,
    },
    ...Array.from({ length: postShardCount }, (_, shard) => ({
      loc: buildPublicUrl(baseUrl, `/sitemaps/posts/${shard}.xml`),
      lastmod: latestPostUpdatedAt,
    })),
  ];
  return buildPublicHttpResource(renderSitemapIndex(entries));
}

export async function buildStaticSitemapResource(
  opts: {
    baseUrl?: string;
  } = {},
): Promise<PublicHttpResource> {
  const baseUrl = getPublicSeoRootUrl(opts.baseUrl);
  const [site, latestPostUpdatedAt, latestTierUpdatedAt] = await Promise.all([
    readPublicSiteInfoWithMetadata(),
    readPublicPostSitemapLastModified(),
    readPublicTierSitemapLastModified(),
  ]);
  const listLastModifiedAt = maxPublicDateOrNull(site.feedIdentityUpdatedAt, latestPostUpdatedAt);
  const tiersLastModifiedAt = maxPublicDateOrNull(site.feedIdentityUpdatedAt, latestTierUpdatedAt);
  // The home page renders tier cards too, so its recency tracks both sources.
  const homeLastModifiedAt = maxPublicDateOrNull(
    site.feedIdentityUpdatedAt,
    latestPostUpdatedAt,
    latestTierUpdatedAt,
  );
  const entries: SitemapEntry[] = [
    { loc: buildPublicUrl(baseUrl, "/"), lastmod: homeLastModifiedAt },
    { loc: buildPublicUrl(baseUrl, "/posts"), lastmod: listLastModifiedAt },
    { loc: buildPublicUrl(baseUrl, "/tiers"), lastmod: tiersLastModifiedAt },
  ];
  return buildPublicHttpResource(renderSitemapUrlSet(entries));
}

export async function buildPostSitemapShardResource(opts: {
  shard: number;
  baseUrl?: string;
  shardSize?: number;
  dbc?: DbClient;
}): Promise<PublicHttpResource | null> {
  const baseUrl = getPublicSeoRootUrl(opts.baseUrl);
  const dbc = opts.dbc ?? getDb();
  const shardSize = opts.shardSize ?? PUBLIC_SITEMAP_SHARD_SIZE;
  if (opts.shard < 0 || opts.shard >= PUBLIC_SITEMAP_MAX_SHARDS) return null;
  const postCount = await countPublicPosts(dbc);
  // Mirrors the index: with zero public posts no shard exists, so shard 0
  // 404s instead of serving an empty (validator-invalid) <urlset>.
  const shardCount = countPublicSitemapPostShards(postCount, shardSize);
  if (opts.shard >= shardCount) return null;
  const posts = await listPublicSitemapShard({
    shard: opts.shard,
    shardSize,
    dbc,
  });
  if (posts.length === 0) return null;
  const entries = posts.map((post: PublicSitemapPostRow) => ({
    loc: buildPostUrl(baseUrl, post.slug),
    lastmod: post.updatedAt,
  }));
  return buildPublicHttpResource(renderSitemapUrlSet(entries));
}

// Slashless prefixes so the exact entrypoints (/admin, /me, ...) are covered
// as well as everything nested beneath them.
const ROBOTS_DISALLOW_PATHS = [
  "/admin",
  "/api/",
  "/download/",
  "/me",
  "/checkout",
  "/login",
] as const;

export function buildRobotsTxt(baseUrl = getPublicSeoRootUrl()): PublicHttpResource {
  const publicBaseUrl = getPublicSeoRootUrl(baseUrl);
  const body = [
    "User-agent: *",
    "Allow: /",
    // Site icons advertised in page metadata resolve under /api/files/, so
    // allow that subtree (longest-match wins) before disallowing the rest of
    // the API; the download routes stay auth-gated regardless of crawling.
    "Allow: /api/files/",
    ...ROBOTS_DISALLOW_PATHS.map((path) => `Disallow: ${path}`),
    `Sitemap: ${buildPublicUrl(publicBaseUrl, "/sitemap.xml")}`,
    "",
  ].join("\n");
  return buildPublicHttpResource(body);
}
