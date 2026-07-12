import type { Metadata } from "next";

import { type PublicSiteInfo } from "@/modules/site";

import { buildPublicUrl, getPublicBaseUrl } from "./public-projection";
import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE } from "./seo";

export const ROOT_DEFAULT_METADATA: Metadata = {
  title: DEFAULT_SITE_TITLE,
  description: DEFAULT_SITE_DESCRIPTION,
};

export function buildRootMetadataFromSite(
  site: PublicSiteInfo,
  baseUrl = getPublicBaseUrl(),
): Metadata {
  const iconUrl = site.siteIconFileId ? `/api/files/${site.siteIconFileId}/download` : undefined;
  const title = site.siteName || DEFAULT_SITE_TITLE;
  const description = site.artistBio.trim() || DEFAULT_SITE_DESCRIPTION;
  return {
    ...ROOT_DEFAULT_METADATA,
    metadataBase: new URL(baseUrl),
    title,
    description,
    icons: iconUrl ? { icon: iconUrl, apple: iconUrl } : undefined,
    openGraph: {
      title,
      siteName: title,
      description,
      type: "website",
      url: buildPublicUrl(baseUrl, "/"),
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}
