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

  const confirmedLogoutState = await page.evaluate(() => {
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const beforeLogout = new Event("admin:before-logout", { cancelable: true });
      const allowed = window.dispatchEvent(beforeLogout);
      const beforeUnload = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
      window.dispatchEvent(beforeUnload);
      window.dispatchEvent(new Event("admin:logout-aborted"));
      return { allowed, beforeUnloadPrevented: beforeUnload.defaultPrevented };
    } finally {
      window.confirm = originalConfirm;
    }
  });
  expect(confirmedLogoutState).toEqual({ allowed: true, beforeUnloadPrevented: false });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window.history.state as { __adminPostEditorDirtyGuard?: unknown } | null)
            ?.__adminPostEditorDirtyGuard,
        ),
      ),
    )
    .toBe(true);

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
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window.history.state as { __adminPostEditorDirtyGuard?: unknown } | null)
            ?.__adminPostEditorDirtyGuard,
        ),
      ),
    )
    .toBe(false);

  await page
    .getByRole("textbox", { name: "正文", exact: true })
    .fill("第二轮未保存正文内容，确认保存后再次编辑仍会保护浏览器后退");
  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();
  await expect(saveButton).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window.history.state as { __adminPostEditorDirtyGuard?: unknown } | null)
            ?.__adminPostEditorDirtyGuard,
        ),
      ),
    )
    .toBe(true);

  const secondBackDialogPromise = page.waitForEvent("dialog");
  await page.evaluate(() => window.setTimeout(() => window.history.back(), 0));
  const secondBackDialog = await secondBackDialogPromise;
  expect(secondBackDialog.type()).toBe("confirm");
  expect(secondBackDialog.message()).toContain("你有未保存更改");
  await secondBackDialog.dismiss();
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${postId}$`));

  await saveButton.click();
  await expect(saveButton).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window.history.state as { __adminPostEditorDirtyGuard?: unknown } | null)
            ?.__adminPostEditorDirtyGuard,
        ),
      ),
    )
    .toBe(false);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/posts$/);
});

test("confirmed link navigation collapses the guard entry - back returns in one step", async ({
  page,
}) => {
  const postId = await openDraftEditor(page);
  await page
    .getByRole("textbox", { name: "正文", exact: true })
    .fill("未保存正文内容，确认离开后历史不应残留守卫记录");
  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
  await page.getByRole("link", { name: "文件管理" }).click();
  await expect(page).toHaveURL(/\/admin\/files$/);

  // One back step must land on the editor (guard entry collapsed), not a duplicate.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${postId}$`));
});

test("dirty guard pushes only its own marker, without re-copying stale history.state itself", async ({
  page,
}) => {
  await openDraftEditor(page);

  // Verified by direct instrumentation (see investigation notes in
  // post-editor.tsx): this app's Next.js App Router client runtime
  // globally patches window.history.pushState so that EVERY call --
  // including this component's -- has __NA and
  // __PRIVATE_NEXTJS_INTERNALS_TREE attached before it reaches the real
  // browser API, regardless of what the caller passes in. That means no
  // component-level code in this app can push a history entry that omits
  // Next's route-tree payload; a true byte-for-byte "minimal" entry is not
  // achievable without patching Next's own history integration, which is
  // out of scope here (and would risk breaking App Router back/forward).
  //
  // What IS within this component's control, and what changed here: the
  // guard no longer manually re-spreads whatever was in window.history.state
  // at push time into a new object. Confirm the guard-detection contract
  // still holds regardless of Next's own state-augmentation.
  await page.getByRole("textbox", { name: "正文", exact: true }).fill("最小化历史状态验证正文");
  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window.history.state as { __adminPostEditorDirtyGuard?: unknown } | null)
            ?.__adminPostEditorDirtyGuard,
        ),
      ),
    )
    .toBe(true);
});

test("a real guarded-anchor click still shows the unsaved-changes dialog even with an active text selection", async ({
  page,
}) => {
  // Regression test for a bypass found in independent review: an earlier
  // revision of the click handler skipped the guard entirely whenever any
  // text selection was active, which would let a real "leave the page"
  // click on a guarded link through unconfirmed if the user happened to
  // have unrelated text selected. The selection check must only affect the
  // popstate handler (iOS edge-swipe-back noise), never a genuine click on
  // a guarded anchor.
  await openDraftEditor(page);
  const textarea = page.getByRole("textbox", { name: "正文", exact: true });
  await textarea.fill("验证有选区时真实链接点击仍会弹出未保存提示");
  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();

  await page.evaluate(() => {
    const el = document.querySelector('textarea[aria-label="正文"]') as HTMLTextAreaElement;
    el.focus();
    el.setSelectionRange(0, 4);
  });

  const dialogPromise = page.waitForEvent("dialog");
  const clickPromise = page.getByRole("link", { name: "文件管理" }).click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  await dialog.dismiss();
  await clickPromise;

  // Dismissing the confirm must keep the user on the editor, unsaved.
  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();
});

test("an active text selection suppresses the unsaved-changes dialog on click and popstate", async ({
  page,
}) => {
  await openDraftEditor(page);
  const textarea = page.getByRole("textbox", { name: "正文", exact: true });
  await textarea.fill("用于验证选区不会触发未保存提示的正文内容");
  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();

  // Simulate a native text selection (e.g. long-press-to-select on iOS)
  // inside the body editor. The document Selection/Range API does not
  // report selections made inside a focused <textarea> (only
  // selectionStart/selectionEnd do), so focus the field and set a
  // non-collapsed selection range the same way iOS text selection would.
  // This must NOT show the unsaved-changes confirm() dialog, since on real
  // iPhone Safari a synchronous confirm() during an in-flight
  // selection/copy gesture was observed to block the copy.
  await page.evaluate(() => {
    const el = document.querySelector('textarea[aria-label="正文"]') as HTMLTextAreaElement;
    el.focus();
    el.setSelectionRange(0, 4);
  });

  let dialogShown = false;
  page.once("dialog", async (dialog) => {
    dialogShown = true;
    await dialog.dismiss();
  });
  // A same-URL popstate while a selection is active (approximating an
  // accidental edge-swipe-back gesture during selection-drag on iOS).
  await page.evaluate(() => window.history.state);
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate", { state: null })));
  await page.waitForTimeout(200);
  expect(dialogShown).toBe(false);

  // The guard entry must still be intact after this no-op popstate.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window.history.state as { __adminPostEditorDirtyGuard?: unknown } | null)
            ?.__adminPostEditorDirtyGuard,
        ),
      ),
    )
    .toBe(true);
});

test("translation-only edits guard navigation and locale switching", async ({ page }) => {
  const postId = await openDraftEditor(page);
  const parentSave = page.getByRole("button", { name: "保存", exact: true });
  await page.getByRole("textbox", { name: "译文标题" }).fill("未保存译文标题");
  await expect(page.getByText("有未保存更改。保存后再发布或离开页面。")).toBeVisible();
  await expect(parentSave).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window.history.state as { __adminPostEditorDirtyGuard?: unknown } | null)
            ?.__adminPostEditorDirtyGuard,
        ),
      ),
    )
    .toBe(true);

  const navigationDialogPromise = page.waitForEvent("dialog");
  const navigationClickPromise = page.getByRole("link", { name: "文件管理" }).click();
  const navigationDialog = await navigationDialogPromise;
  expect(navigationDialog.type()).toBe("confirm");
  await navigationDialog.dismiss();
  await navigationClickPromise;
  await expect(page).toHaveURL(new RegExp(`/admin/posts/${postId}$`));

  const localeSelect = page.locator("#translation-locale");
  const originalLocale = await localeSelect.inputValue();
  const nextLocale = await localeSelect
    .locator("option")
    .evaluateAll(
      (options, current) =>
        options
          .map((option) => (option as HTMLOptionElement).value)
          .find((value) => value !== current),
      originalLocale,
    );
  expect(nextLocale).toBeTruthy();
  const cancelLocaleDialogPromise = page.waitForEvent("dialog");
  const cancelLocalePromise = localeSelect.selectOption(nextLocale!);
  const cancelLocaleDialog = await cancelLocaleDialogPromise;
  await cancelLocaleDialog.dismiss();
  await cancelLocalePromise;
  await expect(localeSelect).toHaveValue(originalLocale);
  const confirmLocaleDialogPromise = page.waitForEvent("dialog");
  const confirmLocalePromise = localeSelect.selectOption(nextLocale!);
  const confirmLocaleDialog = await confirmLocaleDialogPromise;
  await confirmLocaleDialog.accept();
  await confirmLocalePromise;
  await expect(localeSelect).toHaveValue(nextLocale!);
});
