import { describe, expect, it } from "vitest";

import {
  buildFeedMetadata,
  buildPostFeedUrl,
  buildPostGuid,
  escapeXml,
  getFeedBaseUrl,
  isPublicAtomFeedNotModified,
  PUBLIC_ATOM_CACHE_CONTROL,
  PUBLIC_ATOM_CONTENT_TYPE,
  type PublicAtomFeedEntry,
  publicAtomFeedHeaders,
  renderPublicAtomFeed,
  sanitizeXml10,
} from "./feed";

const POST_ID = "11111111-1111-4111-8111-111111111111";

function entry(overrides: Partial<PublicAtomFeedEntry> = {}): PublicAtomFeedEntry {
  return {
    id: POST_ID,
    guid: buildPostGuid(POST_ID),
    title: "Title",
    slug: "post",
    summary: "Summary",
    publishedAt: new Date("2026-07-10T12:00:00.123Z"),
    updatedAt: new Date("2026-07-10T12:00:01.900Z"),
    ...overrides,
  };
}

describe("public Atom feed helpers", () => {
  it("sanitizes XML 1.0-invalid control characters before escaping text", () => {
    const value = "A\u0000\u0008&B<\"'\uD800C\uD83D\uDE00";

    expect(sanitizeXml10(value)).toBe("A&B<\"'C\uD83D\uDE00");
    expect(escapeXml(value)).toBe("A&amp;B&lt;&quot;&apos;C\uD83D\uDE00");
  });

  it("renders escaped feed and entry fields with a feed-level author", () => {
    const xml = renderPublicAtomFeed({
      baseUrl: "https://site.example",
      siteName: "Studio & <Site>",
      authorName: 'Artist "Name"',
      entries: [
        entry({
          title: "T & <x>",
          summary: "S \"quoted\" & 'single'",
          slug: "hello world",
        }),
      ],
    });

    expect(xml).toContain("<title>Studio &amp; &lt;Site&gt;</title>");
    expect(xml).toContain("<author><name>Artist &quot;Name&quot;</name></author>");
    expect(xml).toContain("<title>T &amp; &lt;x&gt;</title>");
    expect(xml).toContain(
      '<summary type="text">S &quot;quoted&quot; &amp; &apos;single&apos;</summary>',
    );
    expect(xml).toContain('href="https://site.example/posts/hello%20world"');
  });

  it("omits summary when the localized summary is absent or empty", () => {
    const xml = renderPublicAtomFeed({
      baseUrl: "https://site.example",
      siteName: "Site",
      authorName: "Artist",
      entries: [entry({ summary: null })],
    });

    expect(xml).not.toContain("<summary");
  });

  it("keeps GUIDs stable across slug and title changes while hiding raw post fields", () => {
    const first = buildPostGuid(POST_ID);
    const second = buildPostGuid(POST_ID);
    const other = buildPostGuid("22222222-2222-4222-8222-222222222222");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).not.toContain(POST_ID);
    expect(first).not.toContain("hello-world");
    expect(first).not.toContain("Title");
  });

  it("normalizes APP_URL and preserves a configured base path", () => {
    expect(getFeedBaseUrl("https://site.example/base///")).toBe("https://site.example/base");
    expect(buildPostFeedUrl("https://site.example/base", "hello/world")).toBe(
      "https://site.example/base/posts/hello%2Fworld",
    );
    expect(getFeedBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(() => getFeedBaseUrl("not a url")).toThrow(/APP_URL/);
    expect(() => getFeedBaseUrl("ftp://site.example")).toThrow(/http or https/);
    expect(() => getFeedBaseUrl("https://site.example/base?utm=1")).toThrow(/query or hash/);
    expect(() => getFeedBaseUrl("https://site.example/base#hash")).toThrow(/query or hash/);
  });

  it("uses strong ETags and route cache headers", () => {
    const feed = buildFeedMetadata("<feed/>", new Date("2026-07-10T12:00:00.000Z"));
    const headers = publicAtomFeedHeaders(feed);

    expect(feed.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(headers.get("content-type")).toBe(PUBLIC_ATOM_CONTENT_TYPE);
    expect(headers.get("cache-control")).toBe(PUBLIC_ATOM_CACHE_CONTROL);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("honors ETag precedence and compares If-Modified-Since to precise milliseconds", () => {
    const feed = buildFeedMetadata("<feed/>", new Date("2026-07-10T12:00:00.900Z"));

    expect(
      isPublicAtomFeedNotModified(
        new Headers({
          "if-none-match": '"different"',
          "if-modified-since": "Fri, 10 Jul 2026 12:00:01 GMT",
        }),
        feed,
      ),
    ).toBe(false);
    expect(isPublicAtomFeedNotModified(new Headers({ "if-none-match": feed.etag }), feed)).toBe(
      true,
    );
    expect(
      isPublicAtomFeedNotModified(
        new Headers({ "if-modified-since": "Fri, 10 Jul 2026 12:00:00 GMT" }),
        feed,
      ),
    ).toBe(false);
    expect(
      isPublicAtomFeedNotModified(
        new Headers({ "if-modified-since": "Fri, 10 Jul 2026 12:00:01 GMT" }),
        feed,
      ),
    ).toBe(true);
  });

  it("matches weak If-None-Match validators and the * wildcard", () => {
    const feed = buildFeedMetadata("<feed/>", new Date("2026-07-10T12:00:00.000Z"));

    expect(
      isPublicAtomFeedNotModified(new Headers({ "if-none-match": `W/${feed.etag}` }), feed),
    ).toBe(true);
    expect(isPublicAtomFeedNotModified(new Headers({ "if-none-match": "*" }), feed)).toBe(true);
    expect(
      isPublicAtomFeedNotModified(
        new Headers({ "if-none-match": `W/"other", ${feed.etag}` }),
        feed,
      ),
    ).toBe(true);
    expect(isPublicAtomFeedNotModified(new Headers({ "if-none-match": 'W/"other"' }), feed)).toBe(
      false,
    );
  });

  it("advances feed-level <updated> when identity changes after all entries", () => {
    const entries = [entry({ updatedAt: new Date("2026-07-10T12:00:01.000Z") })];
    const identityUpdatedAt = new Date("2026-07-11T00:00:00.000Z");

    const withoutIdentity = renderPublicAtomFeed({
      baseUrl: "https://site.example",
      siteName: "Site",
      authorName: "Artist",
      entries,
    });
    const withIdentity = renderPublicAtomFeed({
      baseUrl: "https://site.example",
      siteName: "Site",
      authorName: "Artist",
      entries,
      identityUpdatedAt,
    });
    const emptyWithIdentity = renderPublicAtomFeed({
      baseUrl: "https://site.example",
      siteName: "Site",
      authorName: "Artist",
      entries: [],
      identityUpdatedAt,
    });

    expect(withoutIdentity).toContain("<updated>2026-07-10T12:00:01.000Z</updated>");
    expect(withIdentity).toContain("<updated>2026-07-11T00:00:00.000Z</updated>");
    expect(emptyWithIdentity).toContain("<updated>2026-07-11T00:00:00.000Z</updated>");
  });

  it("changes XML and ETag when the feed title changes", () => {
    const entries = [entry()];
    const firstXml = renderPublicAtomFeed({
      baseUrl: "https://site.example",
      siteName: "First",
      authorName: "Artist",
      entries,
    });
    const secondXml = renderPublicAtomFeed({
      baseUrl: "https://site.example",
      siteName: "Second",
      authorName: "Artist",
      entries,
    });

    expect(firstXml).not.toBe(secondXml);
    expect(buildFeedMetadata(firstXml, entries[0]!.updatedAt).etag).not.toBe(
      buildFeedMetadata(secondXml, entries[0]!.updatedAt).etag,
    );
  });
});
