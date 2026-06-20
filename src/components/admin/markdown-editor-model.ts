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
