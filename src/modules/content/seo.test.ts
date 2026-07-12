import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.APP_URL = "https://artist.example/base";
});

import { renderNextMetadataTags } from "./metadata-tags.test-helper";
import {
  buildListPageSeoCopy,
  buildSiteMetadataFromInfo,
  DEFAULT_SITE_DESCRIPTION,
  DEFAULT_SITE_TITLE,
  ogLocaleForContentLocale,
} from "./seo";

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

describe("content SEO metadata helpers", () => {
  it("builds generic site metadata without site-level images", async () => {
    const metadata = buildSiteMetadataFromInfo(SITE, { canonicalPath: "/" });
    const head = await renderNextMetadataTags(metadata);

    expect(metadata.metadataBase?.toString()).toBe("https://artist.example/base");
    expect(metadata.title).toBe("Public Studio");
    expect(metadata.description).toBe("Studio bio");
    expect(metadata.alternates?.canonical).toBe("https://artist.example/base/");
    expect(metadata.openGraph).toMatchObject({
      siteName: "Public Studio",
      description: "Studio bio",
      title: "Public Studio",
      type: "website",
      url: "https://artist.example/base/",
    });
    expect(head).toContain('<meta property="og:title" content="Public Studio"/>');
    expect(head).toContain('<meta property="og:type" content="website"/>');
    expect(head).toContain('<meta property="og:url" content="https://artist.example/base/"/>');
    expect(head).toContain('<link rel="canonical" href="https://artist.example/base/"/>');
    expect(metadata.twitter).toMatchObject({
      card: "summary",
      title: "Public Studio",
      description: "Studio bio",
    });
    expect(JSON.stringify(metadata.openGraph)).not.toContain("images");
    expect(JSON.stringify(metadata.twitter)).not.toContain("images");
  });

  it("uses generic absolute title and noindex for non-public post metadata", async () => {
    const metadata = buildSiteMetadataFromInfo(SITE, {
      canonicalPath: "/posts/member-secret",
      title: SITE.siteName,
      description: SITE.artistBio,
      absoluteTitle: true,
      noindex: true,
    });
    const head = await renderNextMetadataTags(metadata);

    expect(metadata.title).toEqual({ absolute: "Public Studio" });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.openGraph).toMatchObject({
      title: "Public Studio",
      type: "website",
      url: "https://artist.example/base/posts/member-secret",
    });
    expect(head).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(head).toContain('<meta property="og:title" content="Public Studio"/>');
    expect(head).toContain('<meta property="og:type" content="website"/>');
    expect(head).toContain(
      '<meta property="og:url" content="https://artist.example/base/posts/member-secret"/>',
    );
    expect(head).toContain(
      '<link rel="canonical" href="https://artist.example/base/posts/member-secret"/>',
    );
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
    expect(metadata.openGraph).toMatchObject({
      title: "Posts",
      type: "website",
      url: "https://artist.example/base/posts",
    });
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

  it("uses default-locale SEO copy for crawler-stable list pages", () => {
    expect(buildListPageSeoCopy("posts")).toEqual({
      title: "作品",
      description: "查看创作者最近发布的公开内容与会员更新。",
    });
    expect(buildListPageSeoCopy("tiers")).toEqual({
      title: "会员等级",
      description: "选择会员等级，支持创作者持续发布内容。",
    });
  });

  it("maps supported content locales to OGP locales", () => {
    expect(ogLocaleForContentLocale("zh")).toBe("zh_CN");
    expect(ogLocaleForContentLocale("en")).toBe("en_US");
    expect(ogLocaleForContentLocale("ja")).toBe("ja_JP");
  });
});
