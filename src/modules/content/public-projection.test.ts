import { describe, expect, it } from "vitest";

import {
  buildPostUrl,
  buildPublicHttpResource,
  buildPublicUrl,
  countPublicSitemapPostShards,
  decodePublicPostCursor,
  encodePublicPostCursor,
  escapeXml,
  getPublicBaseUrl,
  isPublicHttpResourceNotModified,
  PUBLIC_SEO_CACHE_CONTROL,
  publicXmlHeaders,
  sanitizeXml10,
} from "./public-projection";

describe("public projection helpers", () => {
  it("normalizes public base URLs while preserving configured base paths", () => {
    expect(getPublicBaseUrl("https://site.example/base///")).toBe("https://site.example/base");
    expect(getPublicBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(() => getPublicBaseUrl("not a url")).toThrow(/APP_URL/);
    expect(() => getPublicBaseUrl("ftp://site.example")).toThrow(/http or https/);
    expect(() => getPublicBaseUrl("https://site.example/base?utm=1")).toThrow(/query or hash/);
    expect(() => getPublicBaseUrl("https://site.example/base#hash")).toThrow(/query or hash/);
  });

  it("builds absolute public URLs without losing the base path", () => {
    expect(buildPublicUrl("https://site.example/base", "/posts")).toBe(
      "https://site.example/base/posts",
    );
    expect(buildPublicUrl("https://site.example/base", "/")).toBe("https://site.example/base/");
    expect(buildPostUrl("https://site.example/base", "hello/world")).toBe(
      "https://site.example/base/posts/hello%2Fworld",
    );
    expect(() => buildPublicUrl("https://site.example", "posts")).toThrow(/must start/);
  });

  it("round-trips precise public post cursors and rejects malformed values", () => {
    const cursor = {
      publishedAt: "2026-06-19T12:34:56.123456Z",
      id: "11111111-1111-4111-8111-111111111111",
    };

    expect(decodePublicPostCursor(encodePublicPostCursor(cursor))).toEqual(cursor);
    expect(
      decodePublicPostCursor(
        encodePublicPostCursor({
          ...cursor,
          publishedAt: "2026-99-99T99:99:99.999999Z",
        }),
      ),
    ).toBeNull();
    expect(
      decodePublicPostCursor(
        encodePublicPostCursor({ publishedAt: "2026-06-19T12:34:56.123Z", id: "bad" }),
      ),
    ).toBeNull();
    expect(decodePublicPostCursor("not-base64")).toBeNull();
    expect(decodePublicPostCursor(null)).toBeNull();
  });

  it("reuses XML 1.0 sanitization and escaping for sitemap-safe text", () => {
    const value = "A\u0000\u0008&B<\"'\uD800C\uD83D\uDE00";

    expect(sanitizeXml10(value)).toBe("A&B<\"'C\uD83D\uDE00");
    expect(escapeXml(value)).toBe("A&amp;B&lt;&quot;&apos;C\uD83D\uDE00");
  });

  it("computes sitemap post shard counts with an injectable shard size", () => {
    expect(countPublicSitemapPostShards(0, 2)).toBe(0);
    expect(countPublicSitemapPostShards(1, 2)).toBe(1);
    expect(countPublicSitemapPostShards(2, 2)).toBe(1);
    expect(countPublicSitemapPostShards(3, 2)).toBe(2);
    expect(countPublicSitemapPostShards(5, 2)).toBe(3);
  });

  it("builds strong validators and public route headers", () => {
    const resource = buildPublicHttpResource("<xml/>", new Date("2026-07-10T12:00:00.900Z"));
    const headers = publicXmlHeaders(resource, "application/xml; charset=utf-8");

    expect(resource.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(headers.get("cache-control")).toBe(PUBLIC_SEO_CACHE_CONTROL);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("vary")).toBeNull();
  });

  it("honors ETag precedence and precise If-Modified-Since comparison", () => {
    const resource = buildPublicHttpResource("<xml/>", new Date("2026-07-10T12:00:00.900Z"));

    expect(
      isPublicHttpResourceNotModified(
        new Headers({
          "if-none-match": '"different"',
          "if-modified-since": "Fri, 10 Jul 2026 12:00:01 GMT",
        }),
        resource,
      ),
    ).toBe(false);
    expect(
      isPublicHttpResourceNotModified(new Headers({ "if-none-match": resource.etag }), resource),
    ).toBe(true);
    expect(
      isPublicHttpResourceNotModified(
        new Headers({ "if-modified-since": "Fri, 10 Jul 2026 12:00:00 GMT" }),
        resource,
      ),
    ).toBe(false);
    expect(
      isPublicHttpResourceNotModified(
        new Headers({ "if-modified-since": "Fri, 10 Jul 2026 12:00:01 GMT" }),
        resource,
      ),
    ).toBe(true);
    expect(isPublicHttpResourceNotModified(new Headers({ "if-none-match": "*" }), resource)).toBe(
      true,
    );
    expect(
      isPublicHttpResourceNotModified(
        new Headers({ "if-none-match": `W/"other", W/${resource.etag}` }),
        resource,
      ),
    ).toBe(true);
  });
});
