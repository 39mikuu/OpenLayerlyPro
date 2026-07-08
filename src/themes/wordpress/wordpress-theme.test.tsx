import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Translate } from "@/modules/i18n";
import type { HomeView, PostCardView, PostDetailView, PostListView } from "@/modules/theme/types";

import { Home } from "./home";
import { PostCard } from "./post-card";
import { PostDetail } from "./post-detail";
import { PostList } from "./post-list";

const t: Translate = (key, params) => `${key}${params ? JSON.stringify(params) : ""}`;

function post(overrides: Partial<PostCardView> = {}): PostCardView {
  return {
    slug: "hello",
    title: "Hello",
    summary: "A short summary",
    coverUrl: "/covers/hello.png",
    visibility: "public",
    publishedAt: new Date("2026-06-20T00:00:00.000Z"),
    categories: [{ name: "Essays", slug: "essays" }],
    tags: [{ name: "Daily", slug: "daily" }],
    ...overrides,
  };
}

function homeView(overrides: Partial<HomeView> = {}): HomeView {
  return {
    siteName: "Site",
    artistName: "Creator",
    bio: "Bio text",
    avatarUrl: "/avatar.png",
    socialLinks: [{ name: "X", url: "https://example.com" }],
    isLoggedIn: false,
    tiers: [
      {
        id: "tier-1",
        name: "Supporter",
        priceLabel: "¥10",
        description: null,
        durationDays: 30,
        purchaseEnabled: true,
        subscriptionEnabled: false,
      },
    ],
    latestPosts: [post()],
    ...overrides,
  };
}

function detailView(overrides: Partial<PostDetailView> = {}): PostDetailView {
  return {
    title: "Protected story",
    publishedAt: new Date("2026-06-20T00:00:00.000Z"),
    visibility: "member",
    requiredTierName: "Supporter",
    summary: "Detail summary",
    coverUrl: "/covers/detail.png",
    isLoggedIn: true,
    allowed: true,
    body: null,
    bodyHtml: "<p>Allowed body</p>",
    images: [{ url: "/images/one.png", alt: "One" }],
    attachments: [
      {
        downloadHref: "/api/files/download/file-1",
        name: "notes.pdf",
        sizeBytes: 2048,
        mimeType: "application/pdf",
        inlineCandidate: false,
      },
      {
        downloadHref: "/api/files/download/video-1",
        name: "video.mp4",
        sizeBytes: 1024 * 1024 * 2,
        mimeType: "video/mp4",
        inlineCandidate: true,
        playHref: "/api/files/play/video-1",
      },
    ],
    machineTranslated: true,
    categories: [{ name: "Essays", slug: "essays" }],
    tags: [{ name: "Daily", slug: "daily" }],
    ...overrides,
  };
}

describe("wordpress theme home", () => {
  it("renders a classic blog main column and sidebar with cover cards", () => {
    const html = renderToStaticMarkup(createElement(Home, { t, view: homeView() }));

    expect(html).toContain("theme.wordpress.label");
    expect(html).toContain("Creator");
    expect(html).toContain("Bio text");
    expect(html).toContain("Supporter");
    expect(html).toContain("Hello");
    expect(html).toContain("/covers/hello.png");
    expect(html).toContain("Essays");
    expect(html).toContain("#Daily");
  });

  it("renders fallback sidebar and empty state without avatar, tiers, or posts", () => {
    const html = renderToStaticMarkup(
      createElement(Home, {
        t,
        view: homeView({ avatarUrl: null, tiers: [], latestPosts: [], socialLinks: [] }),
      }),
    );

    expect(html).toContain("home.empty");
    expect(html).toContain(">C<");
    expect(html).not.toContain("home.supportPlans");
  });

  it("keeps mobile DOM order with content before sidebar", () => {
    const html = renderToStaticMarkup(createElement(Home, { t, view: homeView() }));

    expect(html.indexOf("home.latest")).toBeLessThan(html.indexOf("theme.wordpress.classicBlog"));
  });
});

describe("wordpress theme post list and card", () => {
  it("renders archive cards with optional cover, taxonomy, visibility and pagination", () => {
    const view: PostListView = {
      posts: [
        post(),
        post({ slug: "locked", title: "Locked", coverUrl: null, visibility: "member" }),
      ],
      nextHref: "/posts?after=locked",
    };
    const html = renderToStaticMarkup(createElement(PostList, { t, view }));

    expect(html).toContain("theme.wordpress.archive");
    expect(html).toContain("Hello");
    expect(html).toContain("Locked");
    expect(html).toContain("/covers/hello.png");
    expect(html).toContain('href="/posts?after=locked"');
    expect(html).toContain("theme.wordpress.pageCategories");
    expect(html).toContain("theme.wordpress.pageTags");
  });

  it("omits taxonomy and literal zero for empty categories and tags", () => {
    const html = renderToStaticMarkup(
      createElement(PostCard, { t, post: post({ categories: [], tags: [] }) }),
    );

    expect(html).toContain("Hello");
    expect(html).not.toContain(">0<");
    expect(html).not.toContain("#Daily");
  });

  it("renders empty archive state", () => {
    const html = renderToStaticMarkup(createElement(PostList, { t, view: { posts: [] } }));

    expect(html).toContain("posts.empty");
    expect(html).not.toContain("theme.wordpress.pageCategories");
  });
});

describe("wordpress theme post detail", () => {
  it("renders allowed content, media, attachments and inline video", () => {
    const html = renderToStaticMarkup(createElement(PostDetail, { t, view: detailView() }));

    expect(html).toContain("Protected story");
    expect(html).toContain("Detail summary");
    expect(html).toContain("/covers/detail.png");
    expect(html).toContain("post.machineTranslated");
    expect(html).toContain("Allowed body");
    expect(html).toContain("/images/one.png");
    expect(html).toContain("/api/files/download/file-1");
    expect(html).toContain("/api/files/play/video-1");
    expect(html).toContain("#Daily");
  });

  it("renders login locked state without protected body or file URLs", () => {
    const html = renderToStaticMarkup(
      createElement(PostDetail, {
        t,
        view: detailView({
          visibility: "login",
          requiredTierName: null,
          isLoggedIn: false,
          allowed: false,
        }),
      }),
    );

    expect(html).toContain("post.lockedTitle");
    expect(html).toContain("post.lockedLogin");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("Allowed body");
    expect(html).not.toContain("/images/one.png");
    expect(html).not.toContain("/api/files/download");
    expect(html).not.toContain("/api/files/play");
  });

  it("renders member locked state without protected body or file URLs", () => {
    const html = renderToStaticMarkup(
      createElement(PostDetail, {
        t,
        view: detailView({ allowed: false, isLoggedIn: true }),
      }),
    );

    expect(html).toContain("post.lockedMember");
    expect(html).toContain('href="/tiers"');
    expect(html).not.toContain("Allowed body");
    expect(html).not.toContain("/images/one.png");
    expect(html).not.toContain("/api/files/download");
    expect(html).not.toContain("/api/files/play");
  });

  it("renders public detail without optional sections", () => {
    const html = renderToStaticMarkup(
      createElement(PostDetail, {
        t,
        view: detailView({
          visibility: "public",
          requiredTierName: null,
          summary: null,
          coverUrl: null,
          bodyHtml: null,
          images: [],
          attachments: [],
          machineTranslated: false,
          categories: [],
          tags: [],
        }),
      }),
    );

    expect(html).toContain("Protected story");
    expect(html).not.toContain("Detail summary");
    expect(html).not.toContain(">post.attachments<");
    expect(html).not.toContain("post.download");
    expect(html).not.toContain("post.machineTranslated");
  });
});
