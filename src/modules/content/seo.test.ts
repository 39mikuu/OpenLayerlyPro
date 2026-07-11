import type { Metadata } from "next";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.APP_URL = "https://artist.example/base";
});

import { buildSiteMetadataFromInfo, DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE } from "./seo";

const SITE = {
  initialized: true,
  siteName: "Public Studio",
  artistName: "Artist",
  artistBio: "Studio bio",
  artistAvatarFileId: "avatar-secret",
  siteLogoFileId: "logo-secret",
  siteIconFileId: "icon-secret",
  socialLinks: [],
};

function renderOwnedHead(metadata: Metadata): string {
  const title =
    typeof metadata.title === "string"
      ? metadata.title
      : typeof metadata.title === "object" && metadata.title && "absolute" in metadata.title
        ? metadata.title.absolute
        : "";
  const robots =
    typeof metadata.robots === "object" && metadata.robots
      ? `${metadata.robots.index === false ? "noindex" : "index"},${metadata.robots.follow === false ? "nofollow" : "follow"}`
      : "";
  const openGraph = metadata.openGraph ?? {};
  const twitter = metadata.twitter ?? {};
  return JSON.stringify({ title, robots, openGraph, twitter, alternates: metadata.alternates });
}

describe("content SEO metadata helpers", () => {
  it("builds generic site metadata without site-level images", () => {
    const metadata = buildSiteMetadataFromInfo(SITE, { canonicalPath: "/" });

    expect(metadata.metadataBase?.toString()).toBe("https://artist.example/base");
    expect(metadata.title).toBe("Public Studio");
    expect(metadata.description).toBe("Studio bio");
    expect(metadata.alternates?.canonical).toBe("https://artist.example/base/");
    expect(metadata.openGraph).toMatchObject({
      siteName: "Public Studio",
      description: "Studio bio",
      url: "https://artist.example/base/",
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary",
      title: "Public Studio",
      description: "Studio bio",
    });
    expect(JSON.stringify(metadata.openGraph)).not.toContain("images");
    expect(JSON.stringify(metadata.twitter)).not.toContain("images");
  });

  it("uses generic absolute title and noindex for non-public post metadata", () => {
    const metadata = buildSiteMetadataFromInfo(SITE, {
      canonicalPath: "/posts/member-secret",
      title: SITE.siteName,
      description: SITE.artistBio,
      absoluteTitle: true,
      noindex: true,
    });
    const head = renderOwnedHead(metadata);

    expect(metadata.title).toEqual({ absolute: "Public Studio" });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(head).toContain("noindex,nofollow");
    for (const restricted of [
      "Member Secret Title",
      "Member Secret Summary",
      "cover-secret",
      "category-secret",
      "tag-secret",
      "tier-secret",
    ]) {
      expect(head).not.toContain(restricted);
    }
    expect(head).not.toContain("images");
  });

  it("keeps /posts metadata constant and canonicalized to /posts", () => {
    const metadata = buildSiteMetadataFromInfo(SITE, {
      canonicalPath: "/posts",
      title: "Posts",
      description: "Latest public posts and member updates.",
    });

    expect(metadata.alternates?.canonical).toBe("https://artist.example/base/posts");
    expect(JSON.stringify(metadata)).not.toContain("cursor");
    expect(JSON.stringify(metadata)).not.toContain("category");
    expect(JSON.stringify(metadata)).not.toContain("tag");
  });

  it("falls back to default site title and description", () => {
    const metadata = buildSiteMetadataFromInfo(
      { ...SITE, siteName: "", artistBio: "" },
      { canonicalPath: "/tiers" },
    );

    expect(metadata.title).toBe(DEFAULT_SITE_TITLE);
    expect(metadata.description).toBe(DEFAULT_SITE_DESCRIPTION);
  });
});
