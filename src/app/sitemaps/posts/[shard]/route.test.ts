import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildPostSitemapShardResource: vi.fn(),
}));

vi.mock("@/modules/content/sitemap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/content/sitemap")>();
  return {
    ...actual,
    buildPostSitemapShardResource: mocks.buildPostSitemapShardResource,
  };
});

import { GET } from "./route";

const SITEMAP = {
  body: "<urlset/>",
  etag: '"post-shard-etag"',
  lastModifiedAt: new Date("2026-07-10T12:00:00.900Z"),
  lastModified: "Fri, 10 Jul 2026 12:00:00 GMT",
};

function request(headers: HeadersInit = {}) {
  return new NextRequest("https://site.example/sitemaps/posts/0.xml", { headers });
}

function context(shard: string) {
  return { params: Promise.resolve({ shard }) };
}

describe("post sitemap shard route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPostSitemapShardResource.mockResolvedValue(SITEMAP);
  });

  it("requires strict numeric XML shard params and passes the numeric shard", async () => {
    const response = await GET(request(), context("12.xml"));

    expect(response.status).toBe(200);
    expect(mocks.buildPostSitemapShardResource).toHaveBeenCalledWith({ shard: 12 });
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("etag")).toBe(SITEMAP.etag);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    await expect(response.text()).resolves.toBe(SITEMAP.body);
  });

  it.each(["0", "posts-0.xml", "0.xml.txt", "-1.xml", "abc.xml"])(
    "404s invalid shard param %s",
    async (shard) => {
      const response = await GET(request(), context(shard));

      expect(response.status).toBe(404);
      expect(mocks.buildPostSitemapShardResource).not.toHaveBeenCalled();
    },
  );

  it("404s shards outside the generated range", async () => {
    mocks.buildPostSitemapShardResource.mockResolvedValue(null);

    const response = await GET(request(), context("99.xml"));

    expect(response.status).toBe(404);
  });

  it("returns 304 for matching ETag", async () => {
    const response = await GET(request({ "if-none-match": SITEMAP.etag }), context("0.xml"));

    expect(response.status).toBe(304);
    await expect(response.text()).resolves.toBe("");
  });
});
