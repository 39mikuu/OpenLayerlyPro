import { expect, type Locator, type Page, test } from "@playwright/test";
import { eq, inArray, like, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import {
  downloadLogs,
  files,
  memberships,
  membershipTiers,
  paymentRequests,
  posts,
  sessions,
  siteSettings,
  tasks,
  users,
} from "../src/db/schema";
import { generateSessionToken, hmacSha256 } from "../src/lib/crypto";
import { SESSION_COOKIE } from "../src/modules/auth/session";
import { type Locale, LOCALE_COOKIE } from "../src/modules/i18n/config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const THEME_MODE_COOKIE = "theme_mode";
const ADMIN_EMAIL = "admin-visual-e2e@example.com";
const MEMBER_EMAIL = "admin-visual-m@example.com";
const TIER_SLUG = "admin-visual-e2e-tier";
const POST_SLUG = "admin-visual-e2e-post";
const FILE_OBJECT_PREFIX = "admin-visual-e2e/";
const TASK_DEDUPE_PREFIX = "admin-visual-e2e";
const FIXED_DATE = new Date("2026-03-16T10:30:00.000Z");
// Keep the failed-task screenshot fixture non-claimable by the background dispatcher.
const TASK_RETRY_AFTER_DATE = new Date("2099-03-16T10:30:00.000Z");
const ADMIN_VISUAL_FONT_DIFF_PIXELS = 80_000;
const ADMIN_VISUAL_FONT_DIFF_RATIO = 0.04;
const SEEDED_SETTING_KEYS = [
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
] as const;

type SiteSettingsSnapshot = Map<string, unknown>;
type ThemeMode = "light" | "dark";
let originalSiteSettings: SiteSettingsSnapshot | null = null;
let adminId: string;
let postId: string;

async function snapshotSiteSettings(): Promise<SiteSettingsSnapshot> {
  const rows = await getDb()
    .select({ key: siteSettings.key, valueJson: siteSettings.valueJson })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...SEEDED_SETTING_KEYS]));
  return new Map(rows.map((row) => [row.key, row.valueJson]));
}

async function restoreSiteSettings(snapshot: SiteSettingsSnapshot) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(siteSettings).where(inArray(siteSettings.key, [...SEEDED_SETTING_KEYS]));
    for (const [key, valueJson] of snapshot) {
      await tx.insert(siteSettings).values({ key, valueJson });
    }
  });
}

async function upsertSetting(key: string, valueJson: unknown) {
  await getDb()
    .insert(siteSettings)
    .values({ key, valueJson })
    .onConflictDoUpdate({ target: siteSettings.key, set: { valueJson, updatedAt: sql`now()` } });
}

async function cleanupFixtures() {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(paymentRequests).where(sql`
      ${paymentRequests.userId} in (select id from users where email like 'admin-visual-%@example.com')
      or ${paymentRequests.tierId} in (select id from membership_tiers where slug = ${TIER_SLUG})
    `);
    await tx.delete(downloadLogs).where(sql`
      ${downloadLogs.userId} in (select id from users where email like 'admin-visual-%@example.com')
      or ${downloadLogs.fileId} in (select id from files where object_key like ${`${FILE_OBJECT_PREFIX}%`})
    `);
    await tx.delete(memberships).where(sql`
      ${memberships.userId} in (select id from users where email like 'admin-visual-%@example.com')
      or ${memberships.tierId} in (select id from membership_tiers where slug = ${TIER_SLUG})
    `);
    await tx
      .delete(sessions)
      .where(
        sql`${sessions.userId} in (select id from users where email like 'admin-visual-%@example.com')`,
      );
    await tx.delete(posts).where(eq(posts.slug, POST_SLUG));
    await tx.delete(tasks).where(like(tasks.dedupeKey, `${TASK_DEDUPE_PREFIX}%`));
    await tx.delete(files).where(like(files.objectKey, `${FILE_OBJECT_PREFIX}%`));
    await tx.delete(users).where(like(users.email, "admin-visual-%@example.com"));
    await tx.delete(membershipTiers).where(eq(membershipTiers.slug, TIER_SLUG));
    await tx.delete(siteSettings).where(inArray(siteSettings.key, [...SEEDED_SETTING_KEYS]));
  });
}

async function seedFixtures() {
  await cleanupFixtures();

  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "Admin Visual E2E");
  await upsertSetting("artist_name", "Admin Visual Artist");
  await upsertSetting("artist_bio", "Deterministic admin visual regression fixtures.");
  await upsertSetting("social_links", []);
  await upsertSetting("custom_footer_markup", "");
  await upsertSetting("custom_footer_html", "");
  await upsertSetting("site_verification", []);
  await upsertSetting("public_integrations", []);
  await upsertSetting("public_csp_revision", "admin-visual-e2e");

  const [admin] = await getDb()
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      role: "admin",
      displayName: "Admin Visual E2E",
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
      lastLoginAt: FIXED_DATE,
    })
    .returning({ id: users.id });
  const [member] = await getDb()
    .insert(users)
    .values({
      email: MEMBER_EMAIL,
      role: "member",
      displayName: "Admin Visual Member",
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
      lastLoginAt: FIXED_DATE,
    })
    .returning({ id: users.id });
  const [tier] = await getDb()
    .insert(membershipTiers)
    .values({
      name: "Admin Visual Supporter Tier With Long Name",
      slug: TIER_SLUG,
      description: "Deterministic tier for admin visual screenshots.",
      priceLabel: "$19 / month",
      level: 20,
      durationDays: 31,
      purchaseEnabled: true,
      isActive: true,
      sortOrder: 1,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    })
    .returning({ id: membershipTiers.id });

  const [post] = await getDb()
    .insert(posts)
    .values({
      title: "Admin Visual Regression Post With A Long Stable Title",
      slug: POST_SLUG,
      summary: "Stable summary for admin visual regression coverage.",
      body: "Stable body for the admin post editor visual regression fixture.",
      originalLocale: "en",
      visibility: "member",
      requiredTierId: tier.id,
      status: "draft",
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
      contentUpdatedAt: FIXED_DATE,
    })
    .returning({ id: posts.id });

  await getDb()
    .insert(memberships)
    .values({
      userId: member.id,
      tierId: tier.id,
      source: "manual",
      startsAt: FIXED_DATE,
      endsAt: new Date("2026-04-16T10:30:00.000Z"),
      status: "active",
      createdBy: admin.id,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    });

  const [file] = await getDb()
    .insert(files)
    .values({
      storageDriver: "local",
      objectKey: `${FILE_OBJECT_PREFIX}stable-admin-visual-file.png`,
      originalName: "admin-visual-e2e-long-file-name-for-regression-screenshot.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      purpose: "content_attachment",
      createdBy: admin.id,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    })
    .returning({ id: files.id });

  await getDb().insert(downloadLogs).values({
    userId: member.id,
    fileId: file.id,
    ip: "203.0.113.19",
    userAgent: "admin-visual-e2e",
    storageDriver: "local",
    createdAt: FIXED_DATE,
  });
  await getDb()
    .insert(paymentRequests)
    .values([
      {
        userId: member.id,
        tierId: tier.id,
        status: "pending_review",
        flow: "manual",
        amountLabel: "$19 / month",
        durationDays: 31,
        note: "Stable payment review note for the admin mobile card screenshot.",
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      },
      {
        userId: member.id,
        tierId: tier.id,
        status: "approved",
        flow: "manual",
        amountLabel: "$19 / month",
        durationDays: 31,
        note: "Stable approved payment history row.",
        reviewedAt: FIXED_DATE,
        createdAt: new Date("2026-03-15T10:30:00.000Z"),
        updatedAt: FIXED_DATE,
      },
    ]);
  await getDb()
    .insert(tasks)
    .values([
      {
        kind: "email",
        dedupeKey: `${TASK_DEDUPE_PREFIX}-failed-email`,
        payloadJson: { to: MEMBER_EMAIL },
        status: "failed",
        attempts: 2,
        maxAttempts: 5,
        runAfter: TASK_RETRY_AFTER_DATE,
        lastError: "Email delivery failed",
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      },
      {
        kind: "payment_provider_event.dispatch",
        dedupeKey: `${TASK_DEDUPE_PREFIX}-dead-payment-event`,
        payloadJson: { eventRowId: "00000000-0000-0000-0000-000000000000" },
        status: "dead",
        attempts: 5,
        maxAttempts: 5,
        runAfter: FIXED_DATE,
        lastError: "Task failed permanently",
        createdAt: new Date("2026-03-15T10:30:00.000Z"),
        updatedAt: FIXED_DATE,
      },
    ]);

  adminId = admin.id;
  postId = post.id;
}

async function installAdminSession(page: Page, locale: Locale, mode: ThemeMode) {
  const token = generateSessionToken();
  await getDb()
    .insert(sessions)
    .values({
      userId: adminId,
      tokenHash: hmacSha256(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ip: "127.0.0.1",
      userAgent: "admin-visual-e2e",
    });
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      url: BASE_URL,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
    { name: LOCALE_COOKIE, value: locale, url: BASE_URL, sameSite: "Lax" },
    { name: THEME_MODE_COOKIE, value: mode, url: BASE_URL, sameSite: "Lax" },
  ]);
}

async function expectNoDocumentOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        documentOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        bodyOverflow: document.body.scrollWidth > window.innerWidth + 1,
      })),
    )
    .toEqual({ documentOverflow: false, bodyOverflow: false });
}

function screenshotMasks(page: Page): Locator[] {
  return [
    page.getByText(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/),
    page.locator("[data-nextjs-toast]"),
  ];
}

async function openAdminRoute(
  page: Page,
  input: { locale: Locale; mode: ThemeMode; path: string; width: number },
) {
  await page.setViewportSize({ width: input.width, height: input.width < 768 ? 844 : 900 });
  await installAdminSession(page, input.locale, input.mode);
  await page.goto(input.path);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByTestId("admin-main")).toBeVisible();
  await expectNoDocumentOverflow(page);
  await expect(page.locator("html")).toHaveClass(
    input.mode === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b).*$/,
  );
  if (input.width < 1024) {
    await expect(page.getByTestId("admin-mobile-menu-button")).toBeVisible();
    await expect(page.getByTestId("admin-desktop-sidebar")).toBeHidden();
  } else {
    await expect(page.getByTestId("admin-mobile-menu-button")).toBeHidden();
    await expect(page.getByTestId("admin-desktop-sidebar")).toBeVisible();
  }
}

test.describe.serial("admin visual regression and critical route smoke", () => {
  test.beforeAll(async () => {
    originalSiteSettings = await snapshotSiteSettings();
    await seedFixtures();
  });

  test.afterAll(async () => {
    try {
      await cleanupFixtures();
      if (originalSiteSettings) await restoreSiteSettings(originalSiteSettings);
    } finally {
      await closeDb();
    }
  });

  test("keeps representative admin routes usable across locales, modes, and mobile/desktop widths", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const cases: Array<{ locale: Locale; mode: ThemeMode; path: string; width: number }> = [
      { locale: "zh", mode: "light", path: "/admin/posts", width: 390 },
      { locale: "zh", mode: "light", path: "/admin/posts", width: 1440 },
      { locale: "en", mode: "dark", path: `/admin/posts/${postId}`, width: 1024 },
      { locale: "ja", mode: "dark", path: "/admin/payments/reviews", width: 390 },
      { locale: "en", mode: "light", path: "/admin/files", width: 1440 },
      { locale: "ja", mode: "dark", path: "/admin/tasks", width: 390 },
      { locale: "zh", mode: "light", path: "/admin/settings", width: 390 },
      { locale: "en", mode: "dark", path: "/admin/site", width: 1440 },
    ];

    for (const routeCase of cases) {
      await openAdminRoute(page, routeCase);
    }
  });

  test("captures stable admin visual baselines for critical pages", async ({ page }) => {
    test.setTimeout(120_000);
    const cases: Array<{
      locale: Locale;
      mode: ThemeMode;
      name: string;
      path: string;
      width: number;
    }> = [
      {
        locale: "zh",
        mode: "light",
        name: "admin-posts-desktop-light",
        path: "/admin/posts",
        width: 1440,
      },
      {
        locale: "zh",
        mode: "light",
        name: "admin-payment-reviews-mobile-light",
        path: "/admin/payments/reviews",
        width: 390,
      },
      {
        locale: "en",
        mode: "dark",
        name: "admin-files-desktop-dark",
        path: "/admin/files",
        width: 1440,
      },
      {
        locale: "ja",
        mode: "dark",
        name: "admin-tasks-mobile-dark",
        path: "/admin/tasks",
        width: 390,
      },
    ];

    for (const routeCase of cases) {
      await openAdminRoute(page, routeCase);
      await expect(page).toHaveScreenshot(`${routeCase.name}.png`, {
        animations: "disabled",
        fullPage: true,
        mask: screenshotMasks(page),
        maxDiffPixels: ADMIN_VISUAL_FONT_DIFF_PIXELS,
        maxDiffPixelRatio: ADMIN_VISUAL_FONT_DIFF_RATIO,
      });
    }
  });
});
