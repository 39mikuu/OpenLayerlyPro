import { randomUUID } from "crypto";

import { ApiError } from "@/lib/api";

export type ProtectedMarkdown = {
  markdown: string;
  tokens: ReadonlyMap<string, string>;
  tokenPrefix: string;
};

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

  let protectedText = markdown;

  // Protect complete fenced blocks before inline constructs and URLs.
  protectedText = protectedText.replace(
    /(^|\n)(```+|~~~+)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g,
    (match) => protect(match),
  );
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
