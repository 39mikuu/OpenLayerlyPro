import { expect, test } from "@playwright/test";
import { inArray, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import {
  categories,
  memberships,
  membershipTiers,
  postCategories,
  postFiles,
  posts,
  postTags,
  siteSettings,
  tags,
} from "../src/db/schema";
import { LOCALE_COOKIE } from "../src/modules/i18n/config";
import { BLOG_DEFAULT_COLOR_PRESET_ID } from "../src/themes/blog/color-presets";
import { BUILTIN_DEFAULT_COLOR_PRESET_ID } from "../src/themes/builtin/color-presets";
import { WORDPRESS_DEFAULT_COLOR_PRESET_ID } from "../src/themes/wordpress/color-presets";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
// Duplicated rather than imported from src/modules/theme/registry.ts: that module
// has an unconditional `import "server-only"` at its top, which Next.js's own
// bundler special-cases but which fails to resolve in Playwright's plain Node
// test runner (the package isn't even a real node_modules dependency).
const ACTIVE_THEME_SETTING_KEY = "theme";
const THEME_CONFIG_SETTING_KEY = "theme_config";
const THEME_MODE_COOKIE = "theme_mode";
const SCREENSHOT_LOCALE = "en";

const POST_SLUG = "visual-baseline-studio-notes";
const POST_TITLE = "Visual Baseline Studio Notes";
const CATEGORY_NAME = "Studio Notes";
const TAG_NAME = "Baseline";
const FIXED_PUBLISHED_AT = new Date("2025-03-15T09:30:00.000Z");
const fixtureTierSlugs = ["visual-supporter", "visual-archive-member"] as const;
const fixtureCategorySlug = "studio-notes";
const fixtureTagSlug = "baseline";
const mutatedSettingKeys = [
  "initialized",
  "site_name",
  "artist_name",
  "artist_bio",
  "social_links",
  "custom_footer_markup",
  "custom_footer_html",
  "site_verification",
  "public_integrations",
  "public_csp_revision",
  ACTIVE_THEME_SETTING_KEY,
  THEME_CONFIG_SETTING_KEY,
  "artist_avatar_file_id",
  "site_logo_file_id",
  "site_icon_file_id",
] as const;
type SettingSnapshot = Record<string, unknown | undefined>;
let originalSettings: SettingSnapshot = {};
type HiddenPostSnapshot = { id: string };
type HiddenTierSnapshot = { id: string };
let hiddenPublishedPosts: HiddenPostSnapshot[] = [];
let hiddenActiveTiers: HiddenTierSnapshot[] = [];

type ThemeId = "builtin" | "blog" | "wordpress";
type ThemeMode = "light" | "dark";

const themes: readonly ThemeId[] = ["builtin", "blog", "wordpress"];
const modes: readonly ThemeMode[] = ["light", "dark"];
const pages = [
  { id: "home", path: "/", expectTaxonomy: false },
  { id: "posts", path: "/posts", expectTaxonomy: true },
  { id: "post-detail", path: `/posts/${POST_SLUG}`, expectTaxonomy: true },
] as const;

async function snapshotSettings(keys: readonly string[]): Promise<SettingSnapshot> {
  const rows = await getDb()
    .select({ key: siteSettings.key, valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...keys]));
  const snapshot: SettingSnapshot = Object.fromEntries(keys.map((key) => [key, undefined]));
  for (const row of rows) snapshot[row.key] = row.valueJson;
  return snapshot;
}

async function restoreSettings(snapshot: SettingSnapshot) {
  const db = getDb();
  for (const [key, valueJson] of Object.entries(snapshot)) {
    if (valueJson === undefined) {
      await db.delete(siteSettings).where(sql`${siteSettings.key} = ${key}`);
    } else {
      await db
        .insert(siteSettings)
        .values({ key, valueJson })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { valueJson, updatedAt: new Date() },
        });
    }
  }
}

async function cleanupFixtures() {
  await getDb().transaction(async (tx) => {
    await tx
      .delete(postFiles)
      .where(sql`${postFiles.postId} in (select id from posts where slug = ${POST_SLUG})`);
    await tx
      .delete(postCategories)
      .where(sql`${postCategories.postId} in (select id from posts where slug = ${POST_SLUG})`);
    await tx
      .delete(postTags)
      .where(sql`${postTags.postId} in (select id from posts where slug = ${POST_SLUG})`);
    await tx.delete(posts).where(sql`${posts.slug} = ${POST_SLUG}`);
    await tx.delete(categories).where(sql`${categories.slug} = ${fixtureCategorySlug}`);
    await tx.delete(tags).where(sql`${tags.slug} = ${fixtureTagSlug}`);
    await tx.delete(memberships).where(
      sql`${memberships.tierId} in (select id from membership_tiers where slug in (${sql.join(
        fixtureTierSlugs.map((slug) => sql`${slug}`),
        sql`, `,
      )}))`,
    );
    await tx.delete(membershipTiers).where(inArray(membershipTiers.slug, [...fixtureTierSlugs]));
  });
}

async function hideNonVisualFixtureContent() {
  await getDb().transaction(async (tx) => {
    hiddenPublishedPosts = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(sql`${posts.slug} <> ${POST_SLUG} and ${posts.status} = 'published'`);
    hiddenActiveTiers = await tx
      .select({ id: membershipTiers.id })
      .from(membershipTiers)
      .where(
        sql`${membershipTiers.slug} not in (${sql.join(
          fixtureTierSlugs.map((slug) => sql`${slug}`),
          sql`, `,
        )}) and ${membershipTiers.isActive} = true`,
      );

    if (hiddenPublishedPosts.length > 0) {
      await tx
        .update(posts)
        .set({ status: "archived" })
        .where(
          inArray(
            posts.id,
            hiddenPublishedPosts.map((post) => post.id),
          ),
        );
    }
    if (hiddenActiveTiers.length > 0) {
      await tx
        .update(membershipTiers)
        .set({ isActive: false })
        .where(
          inArray(
            membershipTiers.id,
            hiddenActiveTiers.map((tier) => tier.id),
          ),
        );
    }
  });
}

async function restoreNonVisualFixtureContent() {
  await getDb().transaction(async (tx) => {
    if (hiddenPublishedPosts.length > 0) {
      await tx
        .update(posts)
        .set({ status: "published" })
        .where(
          inArray(
            posts.id,
            hiddenPublishedPosts.map((post) => post.id),
          ),
        );
    }
    if (hiddenActiveTiers.length > 0) {
      await tx
        .update(membershipTiers)
        .set({ isActive: true })
        .where(
          inArray(
            membershipTiers.id,
            hiddenActiveTiers.map((tier) => tier.id),
          ),
        );
    }
  });
}
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
  originalSettings = await snapshotSettings(mutatedSettingKeys);

  await cleanupFixtures();
  await hideNonVisualFixtureContent();
  await db.transaction(async (tx) => {
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
      // Each theme's own real default preset (not an arbitrary fixture choice) - this
      // is what a fresh, unconfigured install actually renders.
      theme_config: {
        builtin: { colorPreset: BUILTIN_DEFAULT_COLOR_PRESET_ID },
        blog: { colorPreset: BLOG_DEFAULT_COLOR_PRESET_ID },
        wordpress: { colorPreset: WORDPRESS_DEFAULT_COLOR_PRESET_ID },
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
  await cleanupFixtures();
  await restoreNonVisualFixtureContent();
  await restoreSettings(originalSettings);
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

test.describe("wordpress theme preset and mobile baselines", () => {
  for (const mode of modes) {
    test(`wordpress layer-seal ${mode} home visual baseline`, async ({ page, context }) => {
      await setActiveTheme("wordpress");
      await upsertSetting("theme_config", {
        builtin: { colorPreset: BUILTIN_DEFAULT_COLOR_PRESET_ID },
        blog: { colorPreset: BLOG_DEFAULT_COLOR_PRESET_ID },
        wordpress: { colorPreset: "layer-seal" },
      });
      await context.addCookies([
        { name: THEME_MODE_COOKIE, value: mode, url: BASE_URL },
        { name: LOCALE_COOKIE, value: SCREENSHOT_LOCALE, url: BASE_URL },
      ]);

      await page.goto("/");
      await expect(page.getByText(POST_TITLE)).toBeVisible();
      await expect(page).toHaveScreenshot(`wordpress-layer-seal-${mode}-home.png`, {
        animations: "disabled",
        fullPage: true,
        mask: [page.getByText(/©\s*\d{4}/)],
      });
    });
  }

  for (const pageCase of pages) {
    test(`wordpress mobile ${pageCase.id} visual baseline`, async ({ page, context }) => {
      await setActiveTheme("wordpress");
      await upsertSetting("theme_config", {
        builtin: { colorPreset: BUILTIN_DEFAULT_COLOR_PRESET_ID },
        blog: { colorPreset: BLOG_DEFAULT_COLOR_PRESET_ID },
        wordpress: { colorPreset: WORDPRESS_DEFAULT_COLOR_PRESET_ID },
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await context.addCookies([
        { name: THEME_MODE_COOKIE, value: "light", url: BASE_URL },
        { name: LOCALE_COOKIE, value: SCREENSHOT_LOCALE, url: BASE_URL },
      ]);

      await page.goto(pageCase.path);
      await expect(page.getByText(POST_TITLE)).toBeVisible();
      await expect(page).toHaveScreenshot(`wordpress-mobile-${pageCase.id}.png`, {
        animations: "disabled",
        fullPage: true,
        mask: [page.getByText(/©\s*\d{4}/)],
      });
    });
  }
});
