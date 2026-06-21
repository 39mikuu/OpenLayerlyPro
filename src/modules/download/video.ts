export const INLINE_VIDEO_MIME_TYPES: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
]);

export function normalizeBaseMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isInlineVideoMime(mimeType: string): boolean {
  return INLINE_VIDEO_MIME_TYPES.has(normalizeBaseMimeType(mimeType));
}
