import { describe, expect, it } from "vitest";

import {
  buildRobotsTxt,
  renderSitemapIndex,
  renderSitemapUrlSet,
  STATIC_SITEMAP_PATHS,
} from "./sitemap";

describe("public sitemap rendering", () => {
  it("renders sitemap indexes and urlsets with XML escaping", () => {
    const lastmod = new Date("2026-07-10T12:00:00.000Z");
    const index = renderSitemapIndex([
      { loc: "https://site.example/sitemaps/static.xml?x=1&y=2", lastmod },
    ]);
    const urlset = renderSitemapUrlSet([{ loc: "https://site.example/posts/a&b", lastmod }]);

    expect(index).toContain("<sitemapindex");
    expect(index).toContain("https://site.example/sitemaps/static.xml?x=1&amp;y=2");
    expect(index).toContain("<lastmod>2026-07-10T12:00:00.000Z</lastmod>");
    expect(urlset).toContain("<urlset");
    expect(urlset).toContain("https://site.example/posts/a&amp;b");
  });

  it("keeps the static sitemap list limited to accepted public pages", () => {
    expect(STATIC_SITEMAP_PATHS).toEqual(["/", "/posts", "/tiers"]);
    expect(STATIC_SITEMAP_PATHS).not.toContain("/admin");
    expect(STATIC_SITEMAP_PATHS).not.toContain("/login");
  });

  it("refuses oversized urlsets", () => {
    expect(() =>
      renderSitemapUrlSet(
        Array.from({ length: 50_001 }, (_, index) => ({
          loc: `https://site.example/posts/${index}`,
        })),
      ),
    ).toThrow(/50,000/);
  });

  it("renders robots.txt with an absolute sitemap and public posts allowed", () => {
    const robots = buildRobotsTxt("https://site.example").body;

    expect(robots).toContain("User-agent: *\nAllow: /\n");
    expect(robots).toContain("Disallow: /admin");
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Disallow: /download/");
    expect(robots).toContain("Disallow: /me");
    expect(robots).toContain("Disallow: /checkout");
    expect(robots).toContain("Disallow: /login");
    expect(robots).toContain("Sitemap: https://site.example/sitemap.xml");
    expect(robots).not.toContain("Disallow: /posts");
  });

  it("prefixes robots rules with the deployment base path", () => {
    const robots = buildRobotsTxt("https://site.example/base").body;

    expect(robots).toContain("Allow: /base/");
    expect(robots).toContain("Disallow: /base/admin");
    expect(robots).toContain("Disallow: /base/api/");
    expect(robots).toContain("Disallow: /base/download/");
    expect(robots).toContain("Disallow: /base/me");
    expect(robots).toContain("Disallow: /base/checkout");
    expect(robots).toContain("Disallow: /base/login");
    expect(robots).toContain("Sitemap: https://site.example/base/sitemap.xml");
    expect(robots).not.toContain("Disallow: /admin\n");
  });
});
