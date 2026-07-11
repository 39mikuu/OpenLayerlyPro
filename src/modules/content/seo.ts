import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";

import { getDb } from "@/db";
import { posts } from "@/db/schema";
import { type PublicSiteInfo, readPublicSiteInfo } from "@/modules/site";

import {
  buildPublicUrl,
  getPublicBaseUrl,
  getPublicPostProjectionBySlug,
} from "./public-projection";

export const DEFAULT_SITE_TITLE = "Artist Member Site";
export const DEFAULT_SITE_DESCRIPTION = "开源画师会员站系统";

type SiteMetadataOptions = {
  title?: string;
  description?: string;
  canonicalPath: string;
  absoluteTitle?: boolean;
  noindex?: boolean;
};

function siteTitle(site: PublicSiteInfo): string {
  return site.siteName || DEFAULT_SITE_TITLE;
}

function siteDescription(site: PublicSiteInfo, fallback = DEFAULT_SITE_DESCRIPTION): string {
  const bio = site.artistBio.trim();
  return bio || fallback;
}

export function buildSiteMetadataFromInfo(
  site: PublicSiteInfo,
  options: SiteMetadataOptions,
): Metadata {
  const baseUrl = getPublicBaseUrl();
  const title = options.title ?? siteTitle(site);
  const description = options.description ?? siteDescription(site);
  const canonicalUrl = buildPublicUrl(baseUrl, options.canonicalPath);
  return {
    metadataBase: new URL(baseUrl),
    title: options.absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: canonicalUrl },
    robots: options.noindex ? { index: false, follow: false } : undefined,
    openGraph: {
      siteName: siteTitle(site),
      description,
      url: canonicalUrl,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export async function buildSiteMetadata(
  canonicalPath: string,
  options: Omit<SiteMetadataOptions, "canonicalPath"> = {},
): Promise<Metadata> {
  const site = await readPublicSiteInfo();
  return buildSiteMetadataFromInfo(site, { ...options, canonicalPath });
}

async function readPublishedPostVisibility(
  slug: string,
): Promise<"public" | "login" | "member" | null> {
  const [row] = await getDb()
    .select({ visibility: posts.visibility })
    .from(posts)
    .where(and(eq(posts.slug, slug), eq(posts.status, "published")))
    .limit(1);
  return row?.visibility ?? null;
}

export async function buildPublicPostMetadata(slug: string): Promise<Metadata> {
  const [site, visibility] = await Promise.all([
    readPublicSiteInfo(),
    readPublishedPostVisibility(slug),
  ]);
  const canonicalPath = `/posts/${encodeURIComponent(slug)}`;
  if (visibility !== "public") {
    return buildSiteMetadataFromInfo(site, {
      canonicalPath,
      title: siteTitle(site),
      description: siteDescription(site),
      absoluteTitle: true,
      noindex: true,
    });
  }

  const post = await getPublicPostProjectionBySlug(slug);
  if (!post) {
    return buildSiteMetadataFromInfo(site, {
      canonicalPath,
      title: siteTitle(site),
      description: siteDescription(site),
      absoluteTitle: true,
      noindex: true,
    });
  }

  const baseUrl = getPublicBaseUrl();
  const canonicalUrl = buildPublicUrl(baseUrl, canonicalPath);
  const description = post.summary ?? siteDescription(site);
  return {
    metadataBase: new URL(baseUrl),
    title: post.title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      type: "article",
      url: canonicalUrl,
      title: post.title,
      description,
      publishedTime: post.publishedAt.toISOString(),
      modifiedTime: post.updatedAt.toISOString(),
      siteName: siteTitle(site),
      locale: post.contentLocale,
    },
    twitter: {
      card: "summary",
      title: post.title,
      description,
    },
  };
}
