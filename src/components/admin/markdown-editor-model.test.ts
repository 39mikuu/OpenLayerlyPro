import { describe, expect, it } from "vitest";

import { insertMarkdownAtSelection } from "./markdown-editor-model";

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
});
