import { randomUUID } from "crypto";

import { ApiError } from "@/lib/api";

export type ProtectedMarkdown = {
  markdown: string;
  tokens: ReadonlyMap<string, string>;
  tokenPrefix: string;
};

type MarkdownLine = {
  start: number;
  end: number;
  content: string;
};

type FenceOpening = {
  marker: "`" | "~";
  length: number;
};

function splitMarkdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;

  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline + 1;
    let contentEnd = newline === -1 ? markdown.length : newline;
    if (contentEnd > start && markdown[contentEnd - 1] === "\r") contentEnd -= 1;
    lines.push({ start, end, content: markdown.slice(start, contentEnd) });
    start = end;
  }

  return lines;
}

function parseFenceOpening(line: string): FenceOpening | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1];
  const marker = fence[0] as FenceOpening["marker"];
  if (marker === "`" && match[2].includes("`")) return null;
  return { marker, length: fence.length };
}

function isFenceClosing(line: string, opening: FenceOpening): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  if (!match) return false;
  const fence = match[1];
  return fence[0] === opening.marker && fence.length >= opening.length;
}

function protectFencedCode(markdown: string, protect: (value: string) => string): string {
  const lines = splitMarkdownLines(markdown);
  if (lines.length === 0) return markdown;

  const output: string[] = [];
  let cursor = 0;
  let index = 0;

  while (index < lines.length) {
    const opening = parseFenceOpening(lines[index].content);
    if (!opening) {
      index += 1;
      continue;
    }

    let closingIndex = index + 1;
    while (closingIndex < lines.length && !isFenceClosing(lines[closingIndex].content, opening)) {
      closingIndex += 1;
    }

    const blockEnd = closingIndex < lines.length ? lines[closingIndex].end : markdown.length;
    output.push(markdown.slice(cursor, lines[index].start));
    output.push(protect(markdown.slice(lines[index].start, blockEnd)));
    cursor = blockEnd;
    index = closingIndex < lines.length ? closingIndex + 1 : lines.length;
  }

  output.push(markdown.slice(cursor));
  return output.join("");
}

export function protectMarkdownForTranslation(markdown: string): ProtectedMarkdown {
  const tokenPrefix = `OLP_MD_${randomUUID().replaceAll("-", "")}_`;
  const tokens = new Map<string, string>();
  let sequence = 0;

  const protect = (value: string): string => {
    const token = `${tokenPrefix}${String(sequence).padStart(4, "0")}_END`;
    sequence += 1;
    tokens.set(token, value);
    return token;
  };

  let protectedText = protectFencedCode(markdown, protect);
  protectedText = protectedText.replace(/^@video:[ \t]+\S+[ \t]*$/gm, (match) => protect(match));
  protectedText = protectedText.replace(/(`+)([^`\n]|`(?!\1))*?\1/g, (match) => protect(match));

  // Protect only the destination portion so link labels and image alt text remain translatable.
  protectedText = protectedText.replace(
    /(!?\[[^\]\n]*\]\([ \t]*)(<[^>\n]+>|(?:\\.|[^\s()<>]|\((?:\\.|[^\s()<>])*\))+)/g,
    (_match, prefix: string, destination: string) => `${prefix}${protect(destination)}`,
  );
  protectedText = protectedText.replace(/https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+/g, (match) =>
    protect(match),
  );

  return { markdown: protectedText, tokens, tokenPrefix };
}

export function restoreProtectedMarkdown(
  translated: string,
  protection: ProtectedMarkdown,
): string {
  const observed = translated.match(/OLP_MD_[0-9a-f]{32}_\d{4,}_END/gi) ?? [];
  const counts = new Map<string, number>();
  for (const token of observed) counts.set(token, (counts.get(token) ?? 0) + 1);

  const expected = [...protection.tokens.keys()];
  const hasModifiedBoundary = expected.some((token) => {
    const index = translated.indexOf(token);
    if (index < 0) return false;
    const before = translated[index - 1] ?? "";
    const after = translated[index + token.length] ?? "";
    return /[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after);
  });
  const invalid =
    observed.length !== expected.length ||
    expected.some((token) => counts.get(token) !== 1) ||
    observed.some((token) => !protection.tokens.has(token)) ||
    hasModifiedBoundary;
  if (invalid) throw new ApiError(502, "translationTokenMismatch");

  let restored = translated;
  for (const [token, original] of protection.tokens) {
    restored = restored.replace(token, original);
  }
  if (restored.includes(protection.tokenPrefix)) {
    throw new ApiError(502, "translationTokenMismatch");
  }
  return restored;
}
