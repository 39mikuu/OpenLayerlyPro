import { describe, expect, it } from "vitest";

import { DEFAULT_LOCALE, isLocale, LOCALE_NAMES, SUPPORTED_LOCALES } from "./config";

describe("locale config", () => {
  it("supports Japanese while keeping Chinese as the default", () => {
    expect(SUPPORTED_LOCALES).toEqual(["zh", "en", "ja"]);
    expect(DEFAULT_LOCALE).toBe("zh");
    expect(isLocale("ja")).toBe(true);
    expect(LOCALE_NAMES.ja).toBe("日本語");
  });
});
