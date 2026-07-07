import { expect, test } from "@playwright/test";
import { inArray, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import {
  categories,
  membershipTiers,
  postCategories,
  postFiles,
  posts,
  postTags,
  siteSettings,
  tags,
} from "../src/db/schema";
import { LOCALE_COOKIE } from "../src/modules/i18n/config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
// Duplicated rather than imported from src/modules/theme/registry.ts: that module
// has an unconditional `import "server-only"` at its top, which Next.js's own
// bundler special-cases but which fails to resolve in Playwright's plain Node
// test runner (the package isn't even a real node_modules dependency).
const ACTIVE_THEME_SETTING_KEY = "theme";
const THEME_MODE_COOKIE = "theme_mode";
const SCREENSHOT_LOCALE = "en";

const POST_SLUG = "visual-baseline-studio-notes";
const POST_TITLE = "Visual Baseline Studio Notes";
const CATEGORY_NAME = "Studio Notes";
const TAG_NAME = "Baseline";
const FIXED_PUBLISHED_AT = new Date("2025-03-15T09:30:00.000Z");

type ThemeId = "builtin" | "blog";
type ThemeMode = "light" | "dark";

const themes: readonly ThemeId[] = ["builtin", "blog"];
const modes: readonly ThemeMode[] = ["light", "dark"];
const pages = [
  { id: "home", path: "/", expectTaxonomy: false },
  { id: "posts", path: "/posts", expectTaxonomy: true },
  { id: "post-detail", path: `/posts/${POST_SLUG}`, expectTaxonomy: true },
] as const;

async function upsertSetting(key: string, valueJson: unknown) {
  await getDb()
    .insert(siteSettings)
    .values({ key, valueJson })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { valueJson, updatedAt: new Date() },
    });
}

async function setActiveTheme(theme: ThemeId) {
  await upsertSetting(ACTIVE_THEME_SETTING_KEY, theme);
}

test.beforeAll(async () => {
  const db = getDb();

  await db.transaction(async (tx) => {
    await tx.delete(postFiles);
    await tx.delete(postCategories);
    await tx.delete(postTags);
    await tx.delete(posts);
    await tx.delete(categories);
    await tx.delete(tags);
    await tx.delete(membershipTiers);

    // Other e2e specs (e.g. s6-security-headers.spec.ts, which runs first) can leave
    // artist_avatar_file_id/site_logo_file_id/site_icon_file_id pointing at files that
    // only resolve under their own test's mocked routes - a stale value here renders
    // as a broken image in our screenshots. Delete rather than upsert-to-null: the
    // file-reference-integrity trigger (migrations/0020) rejects a null value for
    // these keys outright, so a missing row is the only valid "no file set" state.
    await tx
      .delete(siteSettings)
      .where(
        inArray(siteSettings.key, [
          "artist_avatar_file_id",
          "site_logo_file_id",
          "site_icon_file_id",
        ]),
      );

    const siteSettingValues: Record<string, unknown> = {
      initialized: true,
      site_name: "Visual Baseline Site",
      artist_name: "Visual Baseline Artist",
      artist_bio:
        "A deterministic public fixture used to lock the built-in and blog theme visual baselines.",
      // Deliberately omitted: artist_avatar_file_id/site_logo_file_id/site_icon_file_id.
      // A DB trigger (migrations/0020_file_reference_integrity.sql) requires these to be
      // either a real files.id UUID or entirely absent - it has no "set to null to clear"
      // path, so a missing key (same read-side default as null) is the correct fixture state.
      social_links: [
        { name: "Portfolio", url: "https://example.com/portfolio", sortOrder: 1, enabled: true },
      ],
      custom_footer_markup: "",
      custom_footer_html: "",
      site_verification: [],
      public_integrations: [],
      public_csp_revision: "visual-baseline",
      theme_config: {
        builtin: { colorPreset: "neutral" },
        blog: { colorPreset: "ink" },
      },
    };

    for (const [key, valueJson] of Object.entries(siteSettingValues)) {
      await tx
        .insert(siteSettings)
        .values({ key, valueJson })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { valueJson, updatedAt: sql`now()` },
        });
    }

    await tx.insert(membershipTiers).values([
      {
        name: "Supporter",
        slug: "visual-supporter",
        description: "Access the public archive and support ongoing studio notes.",
        priceLabel: "$9 / month",
        level: 10,
        durationDays: 31,
        purchaseEnabled: true,
        isActive: true,
        sortOrder: 1,
      },
      {
        name: "Archive Member",
        slug: "visual-archive-member",
        description: "A deterministic membership card for the home-page baseline.",
        priceLabel: "$19 / month",
        level: 20,
        durationDays: 31,
        purchaseEnabled: true,
        isActive: true,
        sortOrder: 2,
      },
    ]);

    const [category] = await tx
      .insert(categories)
      .values({ name: CATEGORY_NAME, slug: "studio-notes", sortOrder: 1 })
      .returning({ id: categories.id });
    const [tag] = await tx
      .insert(tags)
      .values({ name: TAG_NAME, slug: "baseline" })
      .returning({ id: tags.id });
    const [post] = await tx
      .insert(posts)
      .values({
        title: POST_TITLE,
        slug: POST_SLUG,
        summary: "A stable public post with taxonomy for visual regression coverage.",
        body: [
          "This fixed fixture keeps public theme screenshots comparable across runs.",
          "",
          "It intentionally includes enough prose to exercise post detail typography without relying on external media.",
        ].join("\n"),
        originalLocale: SCREENSHOT_LOCALE,
        visibility: "public",
        status: "published",
        publishedAt: FIXED_PUBLISHED_AT,
      })
      .returning({ id: posts.id });

    await tx.insert(postCategories).values({ postId: post.id, categoryId: category.id });
    await tx.insert(postTags).values({ postId: post.id, tagId: tag.id });
  });
});

test.afterAll(async () => {
  await closeDb();
});

for (const theme of themes) {
  test.describe(`${theme} theme`, () => {
    for (const mode of modes) {
      test.describe(`${mode} mode`, () => {
        for (const pageCase of pages) {
          test(`${pageCase.id} visual baseline`, async ({ page, context }) => {
            await setActiveTheme(theme);
            await context.addCookies([
              { name: THEME_MODE_COOKIE, value: mode, url: BASE_URL },
              { name: LOCALE_COOKIE, value: SCREENSHOT_LOCALE, url: BASE_URL },
            ]);

            await page.goto(pageCase.path);
            await expect(page.getByText(POST_TITLE)).toBeVisible();
            if (pageCase.expectTaxonomy) {
              await expect(page.getByText(CATEGORY_NAME).first()).toBeVisible();
              await expect(page.getByText(`#${TAG_NAME}`).first()).toBeVisible();
            }

            // Both chrome footers render `new Date().getFullYear()`, so the copyright
            // line's year is a known-volatile region - mask it or this baseline fails
            // every January regardless of whether the UI actually changed.
            await expect(page).toHaveScreenshot(`${theme}-${mode}-${pageCase.id}.png`, {
              animations: "disabled",
              fullPage: true,
              mask: [page.getByText(/©\s*\d{4}/)],
            });
          });
        }
      });
    }
  });
}
