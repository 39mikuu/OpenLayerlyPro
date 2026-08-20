import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const CLIENT_TRANSLATION_BOUNDARY = [
  "src/components/i18n-provider.tsx",
  "src/lib/client.ts",
  "src/modules/i18n/client.ts",
  "src/modules/i18n/runtime.ts",
] as const;

describe("client i18n bundle boundary", () => {
  it("keeps locale catalogs out of runtime client imports", () => {
    for (const relativePath of CLIENT_TRANSLATION_BOUNDARY) {
      const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
      expect(source, relativePath).not.toMatch(
        /import\s+(?!type\b)[^;]*from\s+["'][^"']*messages\//,
      );
      expect(source, relativePath).not.toMatch(/from\s+["'](?:@\/modules\/i18n|\.\/translate)["']/);
    }
  });
});
