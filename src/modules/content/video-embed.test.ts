import { describe, expect, it } from "vitest";

import {
  EMBED_FRAME_SOURCES,
  EMBED_HOSTS,
  getAllowedEmbedProvider,
  getSafeVideoIframeAttributes,
  isAllowedEmbedSrc,
  resolveVideoEmbed,
} from "./video-embed";

const YOUTUBE_ID = "dQw4w9WgXcQ";
const BILIBILI_ID = "BV1xx411c7mD";

describe("resolveVideoEmbed", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YOUTUBE_ID}`, "youtube"],
    [`https://youtube.com/watch?v=${YOUTUBE_ID}&list=ignored#fragment`, "youtube"],
    [`https://www.youtube.com/watch/?v=${YOUTUBE_ID}`, "youtube"],
    [`https://youtu.be/${YOUTUBE_ID}`, "youtube"],
    [`https://youtu.be/${YOUTUBE_ID}/?feature=share`, "youtube"],
    [`https://www.youtube.com/shorts/${YOUTUBE_ID}`, "youtube"],
    ["https://vimeo.com/123456789", "vimeo"],
    ["https://www.vimeo.com/123456789/?ignored=yes", "vimeo"],
    [`https://www.bilibili.com/video/${BILIBILI_ID}`, "bilibili"],
    [`https://bilibili.com/video/${BILIBILI_ID}/?spm_id_from=ignored`, "bilibili"],
  ])("resolves %s as %s", (url, provider) => {
    expect(resolveVideoEmbed(url)?.provider).toBe(provider);
  });

  it("normalizes provider output without inheriting user parameters", () => {
    expect(
      resolveVideoEmbed(
        `https://www.youtube.com/watch?v=${YOUTUBE_ID}&autoplay=1&list=evil#fragment`,
      )?.embedSrc,
    ).toBe(`https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`);
    expect(resolveVideoEmbed("https://vimeo.com/123456789?autoplay=1")?.embedSrc).toBe(
      "https://player.vimeo.com/video/123456789",
    );
    expect(
      resolveVideoEmbed(`https://www.bilibili.com/video/${BILIBILI_ID}?autoplay=1`)?.embedSrc,
    ).toBe(`https://player.bilibili.com/player.html?bvid=${BILIBILI_ID}`);
  });

  it.each([
    `http://www.youtube.com/watch?v=${YOUTUBE_ID}`,
    "javascript:alert(1)",
    "data:text/html,boom",
    `//www.youtube.com/watch?v=${YOUTUBE_ID}`,
    `https://user:pass@www.youtube.com/watch?v=${YOUTUBE_ID}`,
    `https://www.youtube.com:444/watch?v=${YOUTUBE_ID}`,
    `https://youtube.com.evil.com/watch?v=${YOUTUBE_ID}`,
    "https://www.youtube.com/watch",
    "https://youtu.be/short",
    "https://youtu.be/dQw4w9WgXcQ/extra",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22%20onload%3Dalert(1)",
    `https://www.youtube.com/watch?v=${YOUTUBE_ID}&v=AAAAAAAAAAA`,
    "https://vimeo.com/",
    "https://vimeo.com/not-digits",
    `https://vimeo.com/${"1".repeat(21)}`,
    "https://vimeo.com.evil.com/123",
    "https://www.bilibili.com/video/AV123",
    "https://www.bilibili.com/video/BV123",
    "https://www.bilibili.com/video/BV1xx411c7mD/extra",
    `https://bilibili.com.evil.com/video/${BILIBILI_ID}`,
    `https://www.youtube.com/watch?v=${YOUTUBE_ID}\nmalicious`,
    ` https://www.youtube.com/watch?v=${YOUTUBE_ID}`,
  ])("rejects unsupported or malformed URL %s", (url) => {
    expect(resolveVideoEmbed(url)).toBeNull();
  });
});

describe("embed source allowlist", () => {
  it.each([
    [`https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`, "youtube"],
    ["https://player.vimeo.com/video/123456789", "vimeo"],
    [`https://player.bilibili.com/player.html?bvid=${BILIBILI_ID}`, "bilibili"],
  ])("accepts canonical source %s", (url, provider) => {
    expect(isAllowedEmbedSrc(url)).toBe(true);
    expect(getAllowedEmbedProvider(url)).toBe(provider);
  });

  it.each([
    `http://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`,
    `https://www.youtube-nocookie.com.evil.com/embed/${YOUTUBE_ID}`,
    `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}#x`,
    "https://player.vimeo.com/video/123?autoplay=1",
    `https://player.bilibili.com/player.html?bvid=${BILIBILI_ID}&autoplay=1`,
    `https://player.bilibili.com/other?bvid=${BILIBILI_ID}`,
  ])("rejects non-canonical source %s", (url) => {
    expect(isAllowedEmbedSrc(url)).toBe(false);
  });

  it("derives fixed iframe attributes from the same canonical source validator", () => {
    expect(
      getSafeVideoIframeAttributes(`https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`),
    ).toEqual({
      src: `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`,
      title: "YouTube video",
      loading: "lazy",
      referrerPolicy: "strict-origin-when-cross-origin",
      allow:
        "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen",
      allowFullscreen: true,
    });
    expect(getSafeVideoIframeAttributes("https://evil.example/embed/video")).toBeNull();
  });

  it("derives future CSP frame sources from the sanitizer host allowlist", () => {
    expect(EMBED_FRAME_SOURCES).toEqual(EMBED_HOSTS.map((host) => `https://${host}`));
  });
});
