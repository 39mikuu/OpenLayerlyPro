import { describe, expect, it } from "vitest";

import { extractInternalImageFileIds, renderMarkdown, sanitizeMarkdownHtml } from "./markdown";

const FILE_ID = "550e8400-e29b-41d4-a716-446655440000";
const YOUTUBE_ID = "dQw4w9WgXcQ";
const BILIBILI_ID = "BV1xx411c7mD";

const VIDEO_URLS = {
  youtube: `https://www.youtube.com/watch?v=${YOUTUBE_ID}&autoplay=1`,
  vimeo: "https://vimeo.com/123456789?autoplay=1",
  bilibili: `https://www.bilibili.com/video/${BILIBILI_ID}?autoplay=1`,
} as const;

describe("renderMarkdown", () => {
  it("renders basic Markdown, tables, and hard line breaks", () => {
    const html = renderMarkdown(
      "# Heading\n\n**bold**\nline two\n\n| A | B |\n| - | - |\n| 1 | 2 |",
    );
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>bold</strong><br />\nline two");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it.each([
    "<script>alert(1)</script>",
    '<img src="/api/files/550e8400-e29b-41d4-a716-446655440000/download" onerror="alert(1)">',
    "<svg><script>alert(1)</script></svg>",
    "<object data=javascript:alert(1)></object>",
    '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>',
  ])("does not allow raw dangerous HTML: %s", (source) => {
    const html = renderMarkdown(source);
    expect(html).not.toMatch(/<(script|svg|object|iframe|img)\b/i);
    expect(html).not.toMatch(/<[^>]+\sonerror=/i);
  });

  it("strips dangerous link schemes", () => {
    const html = renderMarkdown("[bad](javascript:alert(1)) [data](data:text/html,boom)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
  });

  it.each([
    "https://example.com/image.png",
    "http://example.com/image.png",
    "//example.com/image.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "/api/files/not-a-uuid/download",
  ])("removes non-internal image URL %s", (url) => {
    const html = renderMarkdown(`![alt](${url})`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain(url);
  });

  it("keeps a valid internal image URL", () => {
    const path = `/api/files/${FILE_ID}/download`;
    const html = renderMarkdown(`![alt](${path} \"title\")`);
    expect(html).toContain(`<img src="${path}" alt="alt" title="title" />`);
  });
});

describe("public video embed block", () => {
  it.each([
    [VIDEO_URLS.youtube, `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`, "YouTube video"],
    [VIDEO_URLS.vimeo, "https://player.vimeo.com/video/123456789", "Vimeo video"],
    [
      VIDEO_URLS.bilibili,
      `https://player.bilibili.com/player.html?bvid=${BILIBILI_ID}`,
      "Bilibili video",
    ],
  ])("renders a canonical iframe for %s", (watchUrl, embedSrc, title) => {
    const html = renderMarkdown(`@video: ${watchUrl}`, { embedMode: "public" });
    expect(html).toContain('<div class="video-embed">');
    expect(html).toContain(`<iframe src="${embedSrc}"`);
    expect(html).toContain(`title="${title}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerpolicy="strict-origin-when-cross-origin"');
    expect(html).toContain(
      'allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"',
    );
    expect(html).toContain("allowfullscreen");
    expect(html).not.toContain("sandbox");
    expect(html).not.toContain("autoplay=1");
  });

  it("renders multiple top-level video blocks mixed with Markdown", () => {
    const html = renderMarkdown(
      `# Before\n\n@video: ${VIDEO_URLS.youtube}\n\nParagraph\n\n@video: ${VIDEO_URLS.vimeo}`,
    );
    expect(html).toContain("<h1>Before</h1>");
    expect(html.match(/class="video-embed"/g)).toHaveLength(2);
    expect(html).toContain("<p>Paragraph</p>");
  });

  it.each([
    [`\`@video: ${VIDEO_URLS.youtube}\``, "inline code"],
    [`\`\`\`text\n@video: ${VIDEO_URLS.youtube}\n\`\`\``, "fenced code"],
    [`> @video: ${VIDEO_URLS.youtube}`, "blockquote"],
    [`* @video: ${VIDEO_URLS.youtube}`, "list"],
    [` @video: ${VIDEO_URLS.youtube}`, "one-space indent"],
    [`   @video: ${VIDEO_URLS.youtube}`, "three-space indent"],
    [`    @video: ${VIDEO_URLS.youtube}`, "indented code"],
    [`\\@video: ${VIDEO_URLS.youtube}`, "escaped directive"],
    [`Sentence @video: ${VIDEO_URLS.youtube}`, "ordinary sentence"],
  ])("does not transform %s", (source) => {
    const html = renderMarkdown(source, { embedMode: "public" });
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain('class="video-embed"');
  });

  it.each([
    "https://example.com/video",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
  ])("safely falls back for unsupported URL %s", (url) => {
    const html = renderMarkdown(`@video: ${url}`, { embedMode: "public" });
    expect(html).not.toContain("<iframe");
    expect(html).toContain("@video:");
  });
});

describe("preview video embed block", () => {
  it("returns a placeholder without a third-party iframe", () => {
    const html = renderMarkdown(`@video: ${VIDEO_URLS.youtube}`, { embedMode: "preview" });
    expect(html).toContain('class="video-embed-placeholder"');
    expect(html).toContain('data-provider="youtube"');
    expect(html).toContain(`data-embed-src="https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}"`);
    expect(html).toContain('type="button"');
    expect(html).toContain("data-video-embed-load");
    expect(html).not.toContain("<iframe");
  });

  it("uses the same parser contract for public and preview modes", () => {
    const source = `Text\n\n@video: ${VIDEO_URLS.vimeo}`;
    expect(renderMarkdown(source, { embedMode: "public" })).toContain("<iframe");
    expect(renderMarkdown(source, { embedMode: "preview" })).toContain("video-embed-placeholder");
  });
});

describe("video embed sanitizer", () => {
  it("keeps only a canonical iframe and replaces all attributes with fixed values", () => {
    const html = sanitizeMarkdownHtml(
      `<iframe src="https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}" title="user" loading="eager" sandbox srcdoc="boom" style="color:red" onload="boom" data-any="x" allow="camera"></iframe>`,
    );
    expect(html).toContain(`<iframe src="https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}"`);
    expect(html).toContain('title="YouTube video"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("accelerometer");
    expect(html).not.toMatch(/sandbox|srcdoc|style=|onload|data-any|camera/);
  });

  it.each([
    `https://www.youtube.com/embed/${YOUTUBE_ID}`,
    `https://www.youtube-nocookie.com.evil.com/embed/${YOUTUBE_ID}`,
    `http://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`,
    `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}?autoplay=1`,
    "javascript:alert(1)",
  ])("removes a non-canonical iframe source %s", (src) => {
    expect(sanitizeMarkdownHtml(`<iframe src="${src}"></iframe>`)).not.toContain("<iframe");
  });

  it("keeps only a matching canonical placeholder", () => {
    const valid = sanitizeMarkdownHtml(
      `<div class="video-embed-placeholder" data-provider="vimeo" data-embed-src="https://player.vimeo.com/video/123" style="x" data-any="x"><button type="button" data-video-embed-load onclick="x">Vimeo</button></div>`,
    );
    expect(valid).toContain('class="video-embed-placeholder"');
    expect(valid).toContain('data-provider="vimeo"');
    expect(valid).toContain('data-embed-src="https://player.vimeo.com/video/123"');
    expect(valid).toContain("data-video-embed-load");
    expect(valid).not.toMatch(/style=|data-any|onclick/);

    const forged = sanitizeMarkdownHtml(
      `<div class="video-embed-placeholder" data-provider="youtube" data-embed-src="https://evil.example/embed/${YOUTUBE_ID}"><button type="button" data-video-embed-load>Load</button></div>`,
    );
    expect(forged).not.toContain("video-embed-placeholder");
    expect(forged).not.toContain("data-embed-src");
  });
});

describe("extractInternalImageFileIds", () => {
  it("extracts only valid internal Markdown image references", () => {
    const ids = extractInternalImageFileIds(
      `![one](/api/files/${FILE_ID}/download)\n[link](/api/files/${FILE_ID}/download)\n![bad](https://example.com/a.png)`,
    );
    expect([...ids]).toEqual([FILE_ID]);
  });

  it("ignores image-like text inside fenced code", () => {
    const ids = extractInternalImageFileIds(
      `\`\`\`md\n![one](/api/files/${FILE_ID}/download)\n\`\`\``,
    );
    expect(ids.size).toBe(0);
  });
});
