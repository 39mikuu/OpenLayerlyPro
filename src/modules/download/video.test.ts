import { describe, expect, it } from "vitest";

import { INLINE_VIDEO_MIME_TYPES, isInlineVideoMime, normalizeBaseMimeType } from "./video";

describe("inline video MIME helpers", () => {
  it.each(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"])(
    "accepts %s",
    (mimeType) => {
      expect(isInlineVideoMime(mimeType)).toBe(true);
      expect(INLINE_VIDEO_MIME_TYPES.has(mimeType)).toBe(true);
    },
  );

  it("normalizes case, whitespace, and MIME parameters", () => {
    expect(normalizeBaseMimeType(" VIDEO/MP4 ; codecs=avc1 ")).toBe("video/mp4");
    expect(isInlineVideoMime(" VIDEO/MP4 ; codecs=avc1 ")).toBe(true);
  });

  it.each(["application/octet-stream", "video/avi", "video/*", "text/plain", "", "video/mp4evil"])(
    "rejects %s",
    (mimeType) => {
      expect(isInlineVideoMime(mimeType)).toBe(false);
    },
  );
});
