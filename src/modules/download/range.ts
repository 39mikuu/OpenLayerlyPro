export type ByteRange = {
  start: number;
  end: number;
};

export type ParsedByteRange = ByteRange | null | "unsatisfiable";

const MAX_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
const DECIMAL_INTEGER = /^\d+$/;

function parseSafeInteger(value: string): number | null {
  if (!DECIMAL_INTEGER.test(value) || value.length > MAX_INTEGER_DIGITS) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parses one RFC-style bytes range. Malformed/unsupported ranges are ignored
 * (null); syntactically valid but impossible ranges are unsatisfiable (416).
 */
export function parseSingleRange(header: string | null, size: number): ParsedByteRange {
  if (header === null) return null;
  if (!Number.isSafeInteger(size) || size < 0) return null;
  if (header.trim() !== header || !header.startsWith("bytes=")) return null;

  const value = header.slice("bytes=".length);
  if (!value || value.includes(",") || /\s/.test(value)) return null;
  const match = /^(\d*)-(\d*)$/.exec(value);
  if (!match) return null;

  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (!first && !last) return null;

  if (!first) {
    const suffixLength = parseSafeInteger(last);
    if (suffixLength === null) return null;
    if (suffixLength === 0 || size === 0) return "unsatisfiable";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = parseSafeInteger(first);
  if (start === null) return null;
  if (last) {
    const requestedEnd = parseSafeInteger(last);
    if (requestedEnd === null || requestedEnd < start) return null;
    if (size === 0 || start >= size) return "unsatisfiable";
    return { start, end: Math.min(requestedEnd, size - 1) };
  }

  if (size === 0 || start >= size) return "unsatisfiable";
  return { start, end: size - 1 };
}
