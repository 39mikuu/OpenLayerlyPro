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

  it.each([
    [
      "supports up to three leading spaces",
      `   ${"`".repeat(3)}ts\nconst url = "https://inside.example/indented";\n   ${"`".repeat(3)}\n`,
    ],
    [
      "accepts a longer backtick closing fence",
      `${"`".repeat(3)}ts\nconst url = "https://inside.example/long-close";\n${"`".repeat(4)}\n`,
    ],
    [
      "supports tilde fences",
      `${"~".repeat(3)}md\nhttps://inside.example/tilde and inline-looking\n${"~".repeat(4)}\n`,
    ],
    [
      "does not close on a shorter fence inside code",
      `${"`".repeat(4)}md\n${"`".repeat(3)}\nhttps://inside.example/short-inner\n${"`".repeat(5)}\n`,
    ],
    [
      "does not close on a different fence character",
      `${"~".repeat(3)}md\n${"`".repeat(3)}\nhttps://inside.example/different-marker\n${"~".repeat(4)}\n`,
    ],
    [
      "protects an unclosed fence through end of input",
      `${"`".repeat(3)}md\nhttps://inside.example/unclosed\ninline-looking`,
    ],
  ])("%s", (_label, fenced) => {
    const protection = protectMarkdownForTranslation(fenced);

    expect(protection.tokens.size).toBe(1);
    expect([...protection.tokens.values()]).toEqual([fenced]);
    expect(protection.markdown).toMatch(/^OLP_MD_[0-9a-f]{32}_0000_END$/);
    expect(restoreProtectedMarkdown(protection.markdown, protection)).toBe(fenced);
  });

  it("preserves CRLF line endings inside a fenced block", () => {
    const fenced = `  ${"~".repeat(3)}md\r\nhttps://inside.example/crlf\r\n  ${"~".repeat(5)}\r\n`;
    const protection = protectMarkdownForTranslation(fenced);

    expect([...protection.tokens.values()]).toEqual([fenced]);
    expect(restoreProtectedMarkdown(protection.markdown, protection)).toBe(fenced);
  });

  it("restores dollar replacement sequences literally", () => {
    const dollar = "$";
    const fenced = [
      `${"`".repeat(3)}sh`,
      `echo "${dollar}${dollar} ${dollar}& ${dollar}1"`,
      `printf '%s\\n' "${dollar}\`" "${dollar}'"`,
      "`".repeat(3),
    ].join("\n");
    const protection = protectMarkdownForTranslation(fenced);

    expect(restoreProtectedMarkdown(protection.markdown, protection)).toBe(fenced);
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
