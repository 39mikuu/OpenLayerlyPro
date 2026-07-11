import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildStaticSitemapResource: vi.fn(),
}));

vi.mock("@/modules/content/sitemap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/content/sitemap")>();
  return {
    ...actual,
    buildStaticSitemapResource: mocks.buildStaticSitemapResource,
  };
});

import { GET } from "./route";

const SITEMAP = {
  body: "<urlset/>",
  etag: '"static-etag"',
  lastModifiedAt: new Date("2026-07-10T12:00:00.900Z"),
  lastModified: "Fri, 10 Jul 2026 12:00:00 GMT",
};

function request(headers: HeadersInit = {}) {
  return new NextRequest("https://site.example/sitemaps/static.xml", { headers });
}

describe("static sitemap route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildStaticSitemapResource.mockResolvedValue(SITEMAP);
  });

  it("returns XML with public route headers", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
    );
    expect(response.headers.get("etag")).toBe(SITEMAP.etag);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    await expect(response.text()).resolves.toBe(SITEMAP.body);
  });

  it("returns 304 for weak matching ETags", async () => {
    const response = await GET(request({ "if-none-match": `W/${SITEMAP.etag}` }));

    expect(response.status).toBe(304);
    await expect(response.text()).resolves.toBe("");
  });
});
