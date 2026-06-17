import { describe, expect, it } from "vitest";

import { LOCALE_NAMES } from "@/modules/i18n";

describe("LocaleSwitcher", () => {
  it("includes the Japanese locale label", () => {
    expect(LOCALE_NAMES.ja).toBe("日本語");
  });
});
