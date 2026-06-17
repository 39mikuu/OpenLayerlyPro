import { afterEach, describe, expect, it, vi } from "vitest";

async function resolveWith(cookieLocale?: string, acceptLanguage?: string) {
  vi.resetModules();
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) =>
        name === "locale" && cookieLocale ? { value: cookieLocale } : undefined,
    }),
    headers: async () =>
      new Headers(acceptLanguage ? { "accept-language": acceptLanguage } : undefined),
  }));

  const { resolveLocale } = await import("./server");
  return resolveLocale();
}

afterEach(() => {
  vi.doUnmock("next/headers");
  vi.resetModules();
});

describe("resolveLocale", () => {
  it("recognizes a Japanese locale cookie", async () => {
    await expect(resolveWith("ja", "en-US")).resolves.toBe("ja");
  });

  it("recognizes Japanese from Accept-Language", async () => {
    await expect(resolveWith(undefined, "ja-JP,ja;q=0.9,en;q=0.8")).resolves.toBe("ja");
  });

  it("falls back to Chinese for unsupported locales", async () => {
    await expect(resolveWith("fr", "fr-FR")).resolves.toBe("zh");
  });
});
