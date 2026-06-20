import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import { protectMarkdownForTranslation, restoreProtectedMarkdown } from "./markdown-protection";

const SOURCE = `Before https://example.com/raw_(balanced)

[link text](https://example.com/path_(balanced)?q=1)
![alt text](/api/files/550e8400-e29b-41d4-a716-446655440000/download)

\`inline code\`

\`\`\`ts
const url = "https://inside-code.example";
\`\`\`

@video: https://www.youtube.com/watch?v=abc123`;

describe("Markdown translation protection", () => {
  it("restores code, URLs, image destinations, and video directives exactly", () => {
    const protection = protectMarkdownForTranslation(SOURCE);
    expect(protection.markdown).not.toContain("https://example.com/raw_(balanced)");
    expect(protection.markdown).toContain("[link text](OLP_MD_");
    expect(protection.markdown).toContain("![alt text](OLP_MD_");

    const translated = protection.markdown
      .replace("Before", "Después")
      .replace("link text", "texto del enlace")
      .replace("alt text", "texto alternativo");
    expect(restoreProtectedMarkdown(translated, protection)).toBe(
      SOURCE.replace("Before", "Después")
        .replace("link text", "texto del enlace")
        .replace("alt text", "texto alternativo"),
    );
  });

  it.each(["missing", "duplicated", "modified", "unauthorized", "foreign-prefix"])(
    "rejects %s tokens",
    (mode) => {
      const protection = protectMarkdownForTranslation(SOURCE);
      const token = [...protection.tokens.keys()][0];
      let translated = protection.markdown;
      if (mode === "missing") translated = translated.replace(token, "");
      if (mode === "duplicated") translated = `${translated}${token}`;
      if (mode === "modified") translated = translated.replace(token, `${token}x`);
      if (mode === "unauthorized") {
        translated = `${translated}${protection.tokenPrefix}9999_END`;
      }
      if (mode === "foreign-prefix") {
        translated = `${translated} OLP_MD_${"F".repeat(32)}_9999_END`;
      }

      expect(() => restoreProtectedMarkdown(translated, protection)).toThrowError(ApiError);
    },
  );
});
