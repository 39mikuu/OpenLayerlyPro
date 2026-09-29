import { expect, type Page, test } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import { siteSettings } from "../src/db/schema";
import { LOCALE_COOKIE } from "../src/modules/i18n/config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const ACTIVE_THEME_SETTING_KEY = "theme";
const THEME_CONFIG_SETTING_KEY = "theme_config";

const themes = ["builtin", "blog", "wordpress"] as const;
type ThemeId = (typeof themes)[number];

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
] as const;

type SettingSnapshot = Record<string, unknown | undefined>;
let originalSettings: SettingSnapshot = {};

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
      await db.delete(siteSettings).where(eq(siteSettings.key, key));
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

async function seedPublicSiteSettings() {
  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "Public A11y E2E");
  await upsertSetting("artist_name", "Public A11y Artist");
  await upsertSetting("artist_bio", "Accessibility regression fixtures.");
  await upsertSetting("social_links", []);
  await upsertSetting("custom_footer_markup", "");
  await upsertSetting("custom_footer_html", "");
  await upsertSetting("site_verification", []);
  await upsertSetting("public_integrations", []);
  await upsertSetting("public_csp_revision", "public-a11y-e2e");
}

async function useZhLocale(page: Page) {
  await page
    .context()
    .addCookies([{ name: LOCALE_COOKIE, value: "zh", url: BASE_URL, sameSite: "Lax" }]);
}

test.beforeAll(async () => {
  originalSettings = await snapshotSettings(mutatedSettingKeys);
  await seedPublicSiteSettings();
});

test.afterAll(async () => {
  await restoreSettings(originalSettings);
  await closeDb();
});

test.describe("public theme skip links", () => {
  for (const theme of themes) {
    test(`${theme}: Tab focuses skip link and Enter moves focus to #site-main`, async ({
      page,
    }) => {
      await setActiveTheme(theme);
      await useZhLocale(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/");
      await expect(page.locator("#site-main")).toBeAttached();

      await page.keyboard.press("Tab");
      const skipLink = page.getByRole("link", { name: "跳到主内容" });
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toHaveAttribute("href", "#site-main");

      await page.keyboard.press("Enter");
      await expect(page.locator("#site-main")).toBeFocused();
    });
  }
});

test("login form uses real form semantics and live regions", async ({ page }) => {
  await setActiveTheme("builtin");
  await useZhLocale(page);
  await page.goto("/login");

  const form = page.locator("form").first();
  await expect(form).toBeVisible();
  await expect(form.locator('button[type="submit"]').first()).toBeVisible();
  await expect(page.locator('[role="status"][aria-live="polite"]').first()).toBeAttached();
  await expect(page.locator('[role="alert"]').first()).toBeAttached();

  // Fan login email field is present by default (mode=fan).
  await expect(page.locator("#email")).toBeVisible();
});

test("prefers-reduced-motion zeros transition duration on animated chrome controls", async ({
  page,
}) => {
  await setActiveTheme("builtin");
  await useZhLocale(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/login");

  // Buttons use transition-all; the global reduced-motion rule forces ~0 duration.
  const submit = page.locator('form button[type="submit"]').first();
  await expect(submit).toBeVisible();
  const durationMs = await submit.evaluate((el) => {
    const value = getComputedStyle(el).transitionDuration;
    // transition-duration can be a comma-separated list; take the max.
    return Math.max(
      ...value.split(",").map((part) => {
        const trimmed = part.trim();
        if (trimmed.endsWith("ms")) return Number.parseFloat(trimmed);
        if (trimmed.endsWith("s")) return Number.parseFloat(trimmed) * 1000;
        return Number.POSITIVE_INFINITY;
      }),
    );
  });
  expect(durationMs).toBeLessThan(1);
});

test("tiers page renders under active theme without requiring checkout fixtures", async ({
  page,
}) => {
  // Checkout fieldset/radios need seeded payment methods + auth; cover that shape in
  // unit tests. This smoke only checks the public tiers chrome stays reachable.
  await setActiveTheme("builtin");
  await useZhLocale(page);
  await page.goto("/tiers");
  await expect(page.locator("#site-main")).toBeAttached();
  await expect(page.getByRole("link", { name: "跳到主内容" })).toBeAttached();
});
