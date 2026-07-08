import { expect, type Page, test } from "@playwright/test";
import { eq, inArray, like, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import { posts, sessions, siteSettings, users } from "../src/db/schema";
import { generateSessionToken, hmacSha256 } from "../src/lib/crypto";
import { SESSION_COOKIE } from "../src/modules/auth/session";
import { LOCALE_COOKIE } from "../src/modules/i18n/config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const ADMIN_EMAIL = "post-editor-unsaved-e2e-admin@example.com";
const POST_SLUG_PREFIX = "post-editor-unsaved-e2e";
const SEEDED_SETTING_KEYS = ["initialized", "site_name", "artist_name", "artist_bio"] as const;

type SiteSettingsSnapshot = Map<string, unknown>;
let originalSiteSettings: SiteSettingsSnapshot | null = null;
let adminId: string;
let postCounter = 0;

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
    await tx.delete(sessions).where(sql`${sessions.userId} in (
      select id from users where email = ${ADMIN_EMAIL}
    )`);
    await tx.delete(posts).where(like(posts.slug, `${POST_SLUG_PREFIX}%`));
    await tx.delete(users).where(eq(users.email, ADMIN_EMAIL));
    await tx.delete(siteSettings).where(inArray(siteSettings.key, [...SEEDED_SETTING_KEYS]));
  });
}

async function seedFixtures() {
  await cleanupFixtures();
  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "Post Editor Unsaved E2E");
  await upsertSetting("artist_name", "Post Editor Unsaved Artist");
  await upsertSetting("artist_bio", "Post editor unsaved guard fixtures.");

  const [admin] = await getDb()
    .insert(users)
    .values({ email: ADMIN_EMAIL, role: "admin", displayName: "Post Editor Unsaved E2E" })
    .returning({ id: users.id });
  adminId = admin.id;
}

async function seedDraftPost() {
  postCounter += 1;
  const [post] = await getDb()
    .insert(posts)
    .values({
      title: `Post Editor Unsaved Draft ${postCounter}`,
      slug: `${POST_SLUG_PREFIX}-${postCounter}`,
      summary: "Post editor unsaved e2e summary.",
      body: "Post editor unsaved e2e body.",
      originalLocale: "zh",
      visibility: "public",
      status: "draft",
    })
    .returning({ id: posts.id });
  return post.id;
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
      userAgent: "post-editor-unsaved-e2e",
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
    { name: LOCALE_COOKIE, value: "zh", url: BASE_URL, sameSite: "Lax" },
  ]);
}

async function openDraftEditor(page: Page) {
  const postId = await seedDraftPost();
  await installAdminSession(page);
  await page.goto(`/admin/posts/${postId}`);
  await expect(page.getByRole("heading", { name: /编辑/ })).toBeVisible();
  return postId;
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

test("dirty editor shows unsaved state, blocks publish, and returns to saved state after save", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openDraftEditor(page);

  await page.getByRole("textbox", { name: "正文", exact: true }).fill("未保存正文内容");

  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();
  const beforeUnloadPrevented = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(beforeUnloadPrevented).toBe(true);

  let publishRequests = 0;
  await page.route("**/api/admin/posts/*/publish", async (route) => {
    publishRequests += 1;
    await route.abort();
  });
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.getByText("请先保存当前更改，再发布内容。")).toBeVisible();
  expect(publishRequests).toBe(0);

  const saveButton = page.getByRole("button", { name: "保存", exact: true });
  await saveButton.click();
  await expect(page.getByText("当前更改已保存。")).toBeVisible();
  await expect(saveButton).toBeDisabled();
  const savedBeforeUnloadPrevented = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(savedBeforeUnloadPrevented).toBe(false);
});

test("dirty editor guards logout, internal navigation, browser back, and clean back behavior", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const postId = await seedDraftPost();
  await installAdminSession(page);
  await page.goto("/admin/posts");
  await page.getByRole("link", { name: "编辑", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${postId}$`));
  await page
    .getByRole("textbox", { name: "正文", exact: true })
    .fill("未保存正文内容，准备测试离开页面保护");
  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();

  let logoutRequests = 0;
  await page.route("**/api/auth/logout", async (route) => {
    logoutRequests += 1;
    await route.abort();
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("你有未保存更改");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "退出", exact: true }).click();
  expect(logoutRequests).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${postId}$`));

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("你有未保存更改");
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "文件管理" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${postId}$`));

  const backDialogPromise = page.waitForEvent("dialog");
  await page.evaluate(() => window.setTimeout(() => window.history.back(), 0));
  const backDialog = await backDialogPromise;
  expect(backDialog.type()).toBe("confirm");
  expect(backDialog.message()).toContain("你有未保存更改");
  await backDialog.dismiss();
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${postId}$`));

  const saveButton = page.getByRole("button", { name: "保存", exact: true });
  await saveButton.click();
  await expect(page.getByText("当前更改已保存。")).toBeVisible();
  await expect(saveButton).toBeDisabled();
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/posts$/);
});
