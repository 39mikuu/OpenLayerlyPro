import {
  getSafeVideoIframeAttributes,
  resolveVideoEmbed,
  type SafeVideoIframeAttributes,
} from "@/modules/content/video-embed";

export type TextSelection = {
  start: number;
  end: number;
};

export type MarkdownInsertion = {
  value: string;
  cursor: number;
};

function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return length;
  return Math.max(0, Math.min(Math.trunc(offset), length));
}

export type PreviewVideoIframeAttributes = SafeVideoIframeAttributes;

export function insertMarkdownAtSelection(
  currentValue: string,
  selection: TextSelection,
  replacement: string,
  cursorOffset = replacement.length,
): MarkdownInsertion {
  const start = clampOffset(selection.start, currentValue.length);
  const end = Math.max(start, clampOffset(selection.end, currentValue.length));
  return {
    value: `${currentValue.slice(0, start)}${replacement}${currentValue.slice(end)}`,
    cursor: start + clampOffset(cursorOffset, replacement.length),
  };
}

export function insertVideoDirectiveAtSelection(
  currentValue: string,
  selection: TextSelection,
  rawUrl: string,
): MarkdownInsertion | null {
  const resolved = resolveVideoEmbed(rawUrl);
  if (!resolved) return null;

  const start = clampOffset(selection.start, currentValue.length);
  const end = Math.max(start, clampOffset(selection.end, currentValue.length));
  const before = currentValue.slice(0, start);
  const after = currentValue.slice(end);
  const trailingNewlines = before.match(/\n*$/)?.[0].length ?? 0;
  const leadingNewlines = after.match(/^\n*/)?.[0].length ?? 0;
  const leading = before ? "\n".repeat(Math.max(0, 2 - trailingNewlines)) : "";
  const trailing = after ? "\n".repeat(Math.max(0, 2 - leadingNewlines)) : "";
  const replacement = `${leading}@video: ${resolved.originalUrl}${trailing}`;

  return insertMarkdownAtSelection(currentValue, { start, end }, replacement);
}

export function getPreviewVideoIframeAttributes(
  rawSrc: string,
): PreviewVideoIframeAttributes | null {
  return getSafeVideoIframeAttributes(rawSrc);
}
