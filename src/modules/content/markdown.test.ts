import { describe, expect, it } from "vitest";

import { extractInternalImageFileIds, renderMarkdown } from "./markdown";

const FILE_ID = "550e8400-e29b-41d4-a716-446655440000";

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
    '<iframe src="https://example.com"></iframe>',
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

  it("keeps the public and preview option contract stable without enabling embeds", () => {
    const source = "@video: https://www.youtube.com/watch?v=abc";
    expect(renderMarkdown(source, { embedMode: "public" })).toBe(
      renderMarkdown(source, { embedMode: "preview" }),
    );
    expect(renderMarkdown(source)).not.toContain("iframe");
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
