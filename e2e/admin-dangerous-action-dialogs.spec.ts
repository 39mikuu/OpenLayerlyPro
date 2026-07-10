import { expect, type Page, test } from "@playwright/test";
import { eq, inArray, like, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import {
  categories,
  files,
  membershipTiers,
  paymentMethods,
  sessions,
  siteSettings,
  tags,
  tasks,
  users,
} from "../src/db/schema";
import { generateSessionToken, hashPassword, hmacSha256 } from "../src/lib/crypto";
import { SESSION_COOKIE } from "../src/modules/auth/session";
import { LOCALE_COOKIE } from "../src/modules/i18n/config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const ADMIN_EMAIL = "admin-dangerous-actions-e2e@example.com";
const FILE_OBJECT_PREFIX = "admin-dangerous-actions-e2e/";
const TASK_DEDUPE_KEY = "admin-dangerous-actions-e2e-task";
const TIER_SLUG = "dangerous-actions-e2e-tier";
const FUTURE_RUN_AFTER = new Date("2099-07-09T00:00:00.000Z");
const SEEDED_SETTING_KEYS = ["initialized", "site_name", "artist_name", "artist_bio"] as const;

type SiteSettingsSnapshot = Map<string, unknown>;
let originalSiteSettings: SiteSettingsSnapshot | null = null;
let adminId: string;

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
    await tx
      .delete(sessions)
      .where(sql`${sessions.userId} in (select id from users where email = ${ADMIN_EMAIL})`);
    await tx.delete(tasks).where(eq(tasks.dedupeKey, TASK_DEDUPE_KEY));
    await tx.delete(files).where(like(files.objectKey, `${FILE_OBJECT_PREFIX}%`));
    await tx.delete(paymentMethods).where(like(paymentMethods.name, "Dangerous Actions E2E%"));
    await tx.delete(membershipTiers).where(eq(membershipTiers.slug, TIER_SLUG));
    await tx.delete(categories).where(like(categories.slug, "dangerous-actions-e2e%"));
    await tx.delete(tags).where(like(tags.slug, "dangerous-actions-e2e%"));
    await tx.delete(users).where(eq(users.email, ADMIN_EMAIL));
    await tx.delete(siteSettings).where(inArray(siteSettings.key, [...SEEDED_SETTING_KEYS]));
  });
}

async function seedFixtures() {
  await cleanupFixtures();
  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "Dangerous Actions E2E");
  await upsertSetting("artist_name", "Dangerous Actions Artist");
  await upsertSetting("artist_bio", "Dangerous action dialog fixtures.");

  const [admin] = await getDb()
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      role: "admin",
      displayName: "Dangerous Actions Admin",
      passwordHash: await hashPassword("current-password"),
    })
    .returning({ id: users.id });
  adminId = admin!.id;

  await getDb()
    .insert(files)
    .values({
      storageDriver: "local",
      objectKey: `${FILE_OBJECT_PREFIX}sample.png`,
      originalName: "dangerous-actions-e2e-file.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      purpose: "content_attachment",
      createdBy: adminId,
    });
  await getDb().insert(membershipTiers).values({
    name: "Dangerous Actions E2E Tier",
    slug: TIER_SLUG,
    priceLabel: "$5 / month",
    level: 10,
    durationDays: 31,
    purchaseEnabled: true,
    isActive: true,
    sortOrder: 1,
  });
  await getDb().insert(paymentMethods).values({
    name: "Dangerous Actions E2E QR",
    description: "Manual payment method for dangerous action dialogs.",
    isActive: true,
    sortOrder: 1,
  });
  await getDb().insert(categories).values({
    name: "Dangerous Actions Category",
    slug: "dangerous-actions-e2e-category",
    sortOrder: 1,
  });
  await getDb().insert(tags).values({
    name: "Dangerous Actions Tag",
    slug: "dangerous-actions-e2e-tag",
  });
  await getDb()
    .insert(tasks)
    .values({
      kind: "email",
      dedupeKey: TASK_DEDUPE_KEY,
      payloadJson: { to: ADMIN_EMAIL },
      status: "failed",
      attempts: 1,
      maxAttempts: 5,
      runAfter: FUTURE_RUN_AFTER,
      lastError: "Dangerous actions retry fixture",
    });
}

async function installAdminSession(page: Page) {
  const token = generateSessionToken();
  await getDb()
    .insert(sessions)
    .values({
      userId: adminId,
      tokenHash: hmacSha256(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ip: "127.0.0.1",
      userAgent: "admin-dangerous-actions-e2e",
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
    { name: LOCALE_COOKIE, value: "en", url: BASE_URL, sameSite: "Lax" },
  ]);
}

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

test.beforeEach(async ({ page }) => {
  await installAdminSession(page);
});

test("task retry uses a guarded dialog and cannot be dismissed while pending", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/tasks");
  await page.getByRole("button", { name: "Retry", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Retry background task" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("safe to retry");

  let releaseRetry!: () => void;
  const retryRequestStarted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/admin\/tasks\/[^/]+\/retry$/.test(new URL(request.url()).pathname),
  );
  await page.route(/\/api\/admin\/tasks\/[^/]+\/retry$/, async (route) => {
    await new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await dialog.getByRole("button", { name: "Retry task" }).click();
  await retryRequestStarted;
  await expect(dialog.getByRole("button", { name: /Retrying/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);

  releaseRetry();
  await expect(dialog).toBeHidden();
});

test("file deletion shows inline errors in the confirmation dialog instead of alerting", async ({
  page,
}) => {
  const nativeDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.route(/\/api\/admin\/files\/[^/]+$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "File is still referenced" }),
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/files");
  await page.getByRole("button", { name: "Delete" }).first().click();

  const dialog = page.getByRole("dialog", { name: "Delete file" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("content, payment proofs, or site settings");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog.getByRole("alert")).toContainText("File is still referenced");
  expect(nativeDialogs).toEqual([]);
});

test("admin account dangerous actions use guarded confirmation dialogs", async ({ page }) => {
  const token = generateSessionToken();
  await getDb()
    .insert(sessions)
    .values({
      userId: adminId,
      tokenHash: hmacSha256(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ip: "192.0.2.25",
      userAgent: "dangerous-actions-other-browser",
    });

  const nativeDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto("/admin/account");
  await page.locator("#current-password").fill("current-password");
  await page.locator("#new-password").fill("new-secure-password");
  await page.locator("#new-password").press("Enter");
  await expect(page.getByRole("dialog", { name: "Change administrator password" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByTestId("admin-main").getByRole("button", { name: "Update password" }),
  ).toBeFocused();

  await page.locator("#new-email").fill("not-an-email");
  await page.locator("#email-password").fill("current-password");
  await page.getByTestId("admin-main").getByRole("button", { name: "Update email" }).click();
  await expect(page.getByRole("dialog", { name: "Change administrator email" })).toHaveCount(0);

  await page.locator("#new-email").fill("new-admin-dangerous-actions@example.com");
  await page.locator("#email-password").fill("current-password");
  await page.locator("#email-password").press("Enter");
  await expect(page.getByRole("dialog", { name: "Change administrator email" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("admin-main").getByRole("button", { name: "Update email" }).click();
  await expect(page.getByRole("dialog", { name: "Change administrator email" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Sign out other devices" }).click();
  await expect(page.getByRole("dialog", { name: "Sign out other devices" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  const otherSessionRow = page
    .getByText("dangerous-actions-other-browser", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'rounded-lg')][1]");
  await otherSessionRow.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("dialog", { name: "Revoke login session" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByTestId("admin-main").getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("dialog", { name: "Change administrator password" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Update password" }).click();
  await expect(page.locator("#current-password")).toBeFocused();

  await page.locator("#new-email").fill("new-admin-dangerous-actions@example.com");
  await page.locator("#email-password").fill("new-secure-password");
  await page.getByTestId("admin-main").getByRole("button", { name: "Update email" }).click();
  await expect(page.getByRole("dialog", { name: "Change administrator email" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Update email" }).click();
  await expect(page.locator("#email-password")).toBeFocused();

  expect(nativeDialogs).toEqual([]);
});

test("tier, payment method, and taxonomy deletions use named confirmation dialogs", async ({
  page,
}) => {
  const nativeDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto("/admin/tiers");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog", { name: "Delete membership tier" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/admin/payments/methods");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog", { name: "Delete payment method" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/admin/taxonomy");
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByRole("dialog", { name: "Delete category or tag" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  expect(nativeDialogs).toEqual([]);
});
