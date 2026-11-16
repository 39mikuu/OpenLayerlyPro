import { describe, expect, it } from "vitest";

import { renderBlogArticle } from "@/modules/content/markdown";

import { insideLoginDestination, isLegacyReaderPath, isPublicBlogDocument } from "./paths";

describe("personal blog routes", () => {
  it("keeps public document integrations away from reader, authentication and admin routes", () => {
    expect(["/", "/posts", "/posts/hello"].every(isPublicBlogDocument)).toBe(true);
    expect(
      ["/inside", "/inside/posts/hello", "/admin", "/login", "/tiers", "/posts/a/b"].some(
        isPublicBlogDocument,
      ),
    ).toBe(false);
    expect(isLegacyReaderPath("/me/orders")).toBe(true);
    expect(isLegacyReaderPath("/meow")).toBe(false);
  });

  it("returns to an invitation or article after login and rejects ambiguous paths", () => {
    expect(insideLoginDestination("/inside/posts/example")).toBe("/inside/posts/example");
    expect(insideLoginDestination("/inside/invite/example")).toBe("/inside/invite/example");
    for (const path of [
      null,
      "/admin",
      "/inside/login",
      "/inside/posts/%2E%2e",
      "/inside/posts/%2fadmin",
      "/inside/posts/%5cadmin",
    ]) {
      expect(insideLoginDestination(path)).toBe("/inside");
    }
  });
});

describe("blog reading view", () => {
  it("builds stable heading links from sanitized Markdown, including repeated titles", () => {
    const article = renderBlogArticle(
      "## Same\n\n## Same\n\n```\n# Not a heading\n```\n\n<script>bad()</script>",
    );
    expect(article.toc).toEqual([
      { id: "section-1", title: "Same", level: 2 },
      { id: "section-2", title: "Same", level: 2 },
    ]);
    expect(article.html).toContain('<h2 id="section-2">Same</h2>');
    expect(article.html).not.toContain("<script>");
  });
});
