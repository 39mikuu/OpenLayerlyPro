import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildPublicAtomFeed: vi.fn(),
}));

vi.mock("@/modules/content/feed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/content/feed")>();
  return {
    ...actual,
    buildPublicAtomFeed: mocks.buildPublicAtomFeed,
  };
});

import { GET } from "./route";

const FEED = {
  xml: "<feed/>",
  etag: '"etag"',
  lastModifiedAt: new Date("2026-07-10T12:00:00.900Z"),
  lastModified: "Fri, 10 Jul 2026 12:00:00 GMT",
};

function request(headers: HeadersInit = {}) {
  return new NextRequest("https://site.example/feed.xml", { headers });
}

describe("feed.xml route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPublicAtomFeed.mockResolvedValue(FEED);
  });

  it("returns Atom XML with public cache validators and no cookie variance", async () => {
    const response = await GET(
      request({
        cookie: "locale=ja",
        "accept-language": "ja",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
    );
    expect(response.headers.get("etag")).toBe(FEED.etag);
    expect(response.headers.get("last-modified")).toBe(FEED.lastModified);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    await expect(response.text()).resolves.toBe(FEED.xml);
  });

  it("returns 304 for matching ETag", async () => {
    const response = await GET(request({ "if-none-match": FEED.etag }));

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(FEED.etag);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toBe("");
  });

  it("does not collapse same-second If-Modified-Since before the precise update time", async () => {
    const response = await GET(request({ "if-modified-since": "Fri, 10 Jul 2026 12:00:00 GMT" }));

    expect(response.status).toBe(200);
  });
});
