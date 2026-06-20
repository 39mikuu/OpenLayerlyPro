import { describe, expect, it } from "vitest";

import {
  getPreviewVideoIframeAttributes,
  insertMarkdownAtSelection,
  insertVideoDirectiveAtSelection,
} from "./markdown-editor-model";

describe("Markdown editor insertion model", () => {
  it("inserts into the latest value instead of the value captured when an upload started", () => {
    const valueWhenUploadStarted = "Before";
    const latestValueAfterTyping = `${valueWhenUploadStarted} and newer text`;
    const image = "![image](/api/files/550e8400-e29b-41d4-a716-446655440000/download)";

    const result = insertMarkdownAtSelection(
      latestValueAfterTyping,
      { start: latestValueAfterTyping.length, end: latestValueAfterTyping.length },
      image,
    );

    expect(result.value).toBe(`${latestValueAfterTyping}${image}`);
    expect(result.value).toContain("and newer text");
  });

  it("replaces the current selection and clamps stale DOM offsets safely", () => {
    expect(insertMarkdownAtSelection("abc", { start: 1, end: 2 }, "**b**", 2)).toEqual({
      value: "a**b**c",
      cursor: 3,
    });
    expect(insertMarkdownAtSelection("abc", { start: 99, end: 120 }, "x")).toEqual({
      value: "abcx",
      cursor: 4,
    });
  });

  it("inserts a valid video directive on its own line at the current selection", () => {
    const url = "https://youtu.be/dQw4w9WgXcQ";
    expect(insertVideoDirectiveAtSelection("beforeafter", { start: 6, end: 6 }, url)).toEqual({
      value: `before\n\n@video: ${url}\n\nafter`,
      cursor: `before\n\n@video: ${url}\n\n`.length,
    });
  });

  it("adds only the missing blank-line separators around an existing line boundary", () => {
    const url = "https://vimeo.com/123456789";
    expect(insertVideoDirectiveAtSelection("before\nafter", { start: 7, end: 7 }, url)?.value).toBe(
      `before\n\n@video: ${url}\n\nafter`,
    );
    expect(
      insertVideoDirectiveAtSelection("before\n\nafter", { start: 8, end: 8 }, url)?.value,
    ).toBe(`before\n\n@video: ${url}\n\nafter`);
  });

  it("does not modify Markdown for an unsupported video URL", () => {
    expect(
      insertVideoDirectiveAtSelection("before", { start: 6, end: 6 }, "https://example.com/video"),
    ).toBeNull();
  });

  it("returns fixed iframe attributes only for canonical preview sources", () => {
    expect(
      getPreviewVideoIframeAttributes("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"),
    ).toEqual({
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      title: "YouTube video",
      loading: "lazy",
      referrerPolicy: "strict-origin-when-cross-origin",
      allow:
        "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen",
      allowFullscreen: true,
    });
    expect(
      getPreviewVideoIframeAttributes(
        "https://www.youtube-nocookie.com.evil.com/embed/dQw4w9WgXcQ",
      ),
    ).toBeNull();
  });
});
