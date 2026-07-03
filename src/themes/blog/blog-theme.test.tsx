import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Translate } from "@/modules/i18n";
import type { HomeView, PostCardView, PostListView } from "@/modules/theme/types";

import { Home } from "./home";
import { PostList } from "./post-list";

const t: Translate = (key) => key;

function post(overrides: Partial<PostCardView> = {}): PostCardView {
  return {
    slug: "hello",
    title: "Hello",
    summary: "A short summary",
    coverUrl: "/covers/hello.png",
    visibility: "public",
    publishedAt: new Date("2026-06-20T00:00:00.000Z"),
    categories: [{ name: "随笔", slug: "essay" }],
    tags: [{ name: "日常", slug: "daily" }],
    ...overrides,
  };
}

function homeView(overrides: Partial<HomeView> = {}): HomeView {
  return {
    siteName: "Site",
    artistName: "Creator",
    bio: "Bio text",
    avatarUrl: null,
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

describe("blog theme home", () => {
  it("renders intro, compact tier strip, and text-first post entries without covers", () => {
    const html = renderToStaticMarkup(createElement(Home, { t, view: homeView() }));

    expect(html).toContain("Creator");
    expect(html).toContain("Bio text");
    expect(html).toContain("Supporter ¥10");
    expect(html).toContain('href="/tiers"');
    expect(html).toContain("Hello");
    expect(html).toContain("A short summary");
    expect(html).toContain("2026-06-20");
    // 文字优先：博客首页不渲染封面缩略图。
    expect(html).not.toContain("covers/hello.png");
  });

  it("omits the tier strip when no tiers exist and shows the empty state without posts", () => {
    const html = renderToStaticMarkup(
      createElement(Home, { t, view: homeView({ tiers: [], latestPosts: [] }) }),
    );

    expect(html).not.toContain("home.supportPlans");
    expect(html).toContain("home.empty");
  });
});

describe("blog theme post list", () => {
  it("renders entries with visibility badge for non-public posts and keyset pagination", () => {
    const view: PostListView = {
      posts: [post(), post({ slug: "locked", title: "Locked", visibility: "member" })],
      nextHref: "/posts?after=locked",
    };
    const html = renderToStaticMarkup(createElement(PostList, { t, view }));

    expect(html).toContain("Hello");
    expect(html).toContain("Locked");
    expect(html).toContain('href="/posts?after=locked"');
    expect(html).toContain("posts.nextPage");
  });

  it("renders the empty state", () => {
    const html = renderToStaticMarkup(createElement(PostList, { t, view: { posts: [] } }));

    expect(html).toContain("posts.empty");
  });
});
