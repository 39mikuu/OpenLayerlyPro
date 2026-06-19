import { describe, expect, it } from "vitest";

import { slugifyTaxonomy } from "./index";

describe("taxonomy slug", () => {
  it("normalizes a human-readable name", () => {
    expect(slugifyTaxonomy("  New Releases 2026 ")).toBe("new-releases-2026");
  });

  it("rejects a value that cannot produce a slug", () => {
    expect(() => slugifyTaxonomy("分类")).toThrowError("taxonomySlugRequired");
  });
});
