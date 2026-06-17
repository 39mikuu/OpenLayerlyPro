import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { posts, postTranslations } from "./index";

describe("content i18n schema", () => {
  it("keeps existing posts on the Chinese original locale", () => {
    expect(posts.originalLocale.default).toBe("zh");
    expect(posts.originalLocale.notNull).toBe(true);
  });

  it("cascades translations when a post is deleted", () => {
    const config = getTableConfig(postTranslations);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
  });

  it("defines the published partial unique index and lookup index", () => {
    const config = getTableConfig(postTranslations);
    const indexes = config.indexes.map((item) => item.config);
    const published = indexes.find(
      (item) => item.name === "post_translations_one_published_per_locale",
    );
    const lookup = indexes.find((item) => item.name === "post_translations_lookup_idx");

    expect(published?.unique).toBe(true);
    expect(published?.where).toBeDefined();
    expect(lookup?.unique).toBe(false);
  });
});
