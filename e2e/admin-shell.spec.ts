import { expect, type Page, test } from "@playwright/test";
import { eq, inArray, like, sql } from "drizzle-orm";
import sharp from "sharp";

import { closeDb, getDb } from "../src/db";
import {
  downloadLogs,
  files,
  memberships,
  membershipTiers,
  notificationCampaigns,
  paymentRequests,
  postFiles,
  posts,
  sessions,
  siteSettings,
  tasks,
  users,
} from "../src/db/schema";
import { generateSessionToken, hmacSha256 } from "../src/lib/crypto";
import { SESSION_COOKIE } from "../src/modules/auth/session";
import { LOCALE_COOKIE } from "../src/modules/i18n/config";
import { LocalStorageAdapter } from "../src/modules/storage/local";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const ADMIN_EMAIL = "admin-shell-e2e@example.com";
const MEMBER_EMAIL = "admin-shell-member@example.com";
const POST_SLUG = "admin-shell-e2e-post";
const TIER_SLUG = "admin-shell-e2e-tier";
const SITE_ASSET_OBJECT_KEY = "admin-shell-e2e/site-asset.png";
const PUBLIC_INTEGRATION_SCRIPT_URL = "https://admin-shell-public.example/integration.js";
const PUBLIC_INTEGRATION_ORIGIN = "https://admin-shell-public.example";
const SEEDED_SETTING_KEYS = [
  "initialized",
  "site_name",
  "artist_name",
  "artist_bio",
  "artist_avatar_file_id",
  "site_logo_file_id",
  "site_icon_file_id",
  "social_links",
  "custom_footer_markup",
  "custom_footer_html",
  "site_verification",
  "public_integrations",
  "public_csp_revision",
] as const;

type SiteSettingsSnapshot = Map<string, unknown>;
let originalSiteSettings: SiteSettingsSnapshot | null = null;
let seededPostId = "";

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
    await tx.delete(siteSettings).where(inArray(siteSettings.key, [...SEEDED_SETTING_KEYS]));
    await tx.delete(paymentRequests).where(sql`
      ${paymentRequests.userId} in (select id from users where email like 'admin-shell-%@example.com')
      or ${paymentRequests.tierId} in (select id from membership_tiers where slug = ${TIER_SLUG})
    `);
    await tx.delete(downloadLogs).where(sql`
      ${downloadLogs.userId} in (select id from users where email like 'admin-shell-%@example.com')
      or ${downloadLogs.fileId} in (select id from files where object_key like 'admin-shell-e2e/%')
    `);
    await tx.delete(memberships).where(sql`
      ${memberships.userId} in (select id from users where email like 'admin-shell-%@example.com')
      or ${memberships.tierId} in (select id from membership_tiers where slug = ${TIER_SLUG})
    `);
    await tx
      .delete(sessions)
      .where(
        sql`${sessions.userId} in (select id from users where email like 'admin-shell-%@example.com')`,
      );
    await tx.delete(posts).where(eq(posts.slug, POST_SLUG));
    await tx.delete(tasks).where(like(tasks.dedupeKey, "admin-shell-e2e%"));
    await tx.delete(files).where(like(files.objectKey, "admin-shell-e2e/%"));
    await tx.delete(users).where(like(users.email, "admin-shell-%@example.com"));
    await tx.delete(membershipTiers).where(eq(membershipTiers.slug, TIER_SLUG));
  });
  await new LocalStorageAdapter().deleteObject({ objectKey: SITE_ASSET_OBJECT_KEY });
}

async function seedFixtures() {
  await cleanupFixtures();

  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "Admin Shell E2E");
  await upsertSetting("artist_name", "Admin Shell Artist");
  await upsertSetting("artist_bio", "Admin shell responsive fixtures.");
  await upsertSetting("social_links", [
    {
      name: "Admin Shell Social Link",
      url: "https://example.com/admin-shell-social-link-with-a-very-long-unbroken-mobile-value",
    },
  ]);
  await upsertSetting("custom_footer_markup", "");
  await upsertSetting("custom_footer_html", "");
  await upsertSetting("site_verification", []);
  await upsertSetting("public_integrations", []);
  await upsertSetting("public_csp_revision", "admin-shell-e2e");

  const [admin] = await getDb()
    .insert(users)
    .values({ email: ADMIN_EMAIL, role: "admin", displayName: "Admin Shell E2E" })
    .returning({ id: users.id });
  const [member] = await getDb()
    .insert(users)
    .values({ email: MEMBER_EMAIL, role: "member", displayName: "Admin Shell Member" })
    .returning({ id: users.id });
  const [tier] = await getDb()
    .insert(membershipTiers)
    .values({
      name: "Admin Shell Long Tier Name For Responsive Checks",
      slug: TIER_SLUG,
      priceLabel: "$9 / month",
      level: 10,
      durationDays: 31,
      purchaseEnabled: true,
      isActive: true,
      sortOrder: 1,
    })
    .returning({ id: membershipTiers.id });

  const [post] = await getDb()
    .insert(posts)
    .values({
      title: "Admin Shell E2E Long Post Title For Responsive Checks",
      slug: POST_SLUG,
      summary: "Admin shell responsive post summary.",
      body: "Admin shell responsive post body.",
      originalLocale: "en",
      visibility: "member",
      requiredTierId: tier.id,
      status: "draft",
    })
    .returning({ id: posts.id });
  if (!post) throw new Error("failed to seed admin shell post");
  seededPostId = post.id;
  await getDb().insert(notificationCampaigns).values({
    postId: post.id,
    source: "scheduled_publish",
    status: "dead",
    publishedAt: new Date(),
    cursorUserId: member.id,
    expansionCompletedAt: new Date(),
    lastError:
      "Admin-shell-notification-error-with-a-very-long-unbroken-diagnostic-value-for-mobile-wrapping",
  });
  await getDb()
    .insert(memberships)
    .values({
      userId: member.id,
      tierId: tier.id,
      source: "manual",
      startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: "active",
    });
  const [file] = await getDb()
    .insert(files)
    .values({
      storageDriver: "local",
      objectKey: "admin-shell-e2e/long-responsive-file-name.png",
      originalName: "admin-shell-e2e-long-file-name-for-mobile-card-responsive-checks.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      purpose: "content_attachment",
      createdBy: admin.id,
    })
    .returning({ id: files.id });
  await getDb().insert(postFiles).values({
    postId: post.id,
    fileId: file.id,
    kind: "attachment",
    sortOrder: 0,
  });
  const siteAssetBody = await sharp({
    create: {
      width: 1200,
      height: 120,
      channels: 3,
      background: { r: 20, g: 120, b: 220 },
    },
  })
    .png()
    .toBuffer();
  await new LocalStorageAdapter().putObject({
    objectKey: SITE_ASSET_OBJECT_KEY,
    body: siteAssetBody,
    contentType: "image/png",
  });
  const [siteAsset] = await getDb()
    .insert(files)
    .values({
      storageDriver: "local",
      objectKey: SITE_ASSET_OBJECT_KEY,
      originalName: "admin-shell-site-asset.png",
      mimeType: "image/png",
      sizeBytes: siteAssetBody.length,
      purpose: "artist_avatar",
      createdBy: admin.id,
    })
    .returning({ id: files.id });
  await upsertSetting("artist_avatar_file_id", siteAsset.id);
  await upsertSetting("site_logo_file_id", siteAsset.id);
  await upsertSetting("site_icon_file_id", siteAsset.id);
  await getDb().insert(downloadLogs).values({
    userId: member.id,
    fileId: file.id,
    ip: "203.0.113.8",
    userAgent: "admin-shell-e2e",
    storageDriver: "local",
  });
  await getDb().insert(paymentRequests).values({
    userId: member.id,
    tierId: tier.id,
    status: "pending_review",
    flow: "manual",
    amountLabel: "$9 / month",
    durationDays: 31,
    note: "Admin shell payment review row.",
  });
  await getDb()
    .insert(tasks)
    .values({
      kind: "email",
      dedupeKey: "admin-shell-e2e-email",
      payloadJson: { to: MEMBER_EMAIL },
      status: "failed",
      attempts: 1,
      maxAttempts: 5,
      lastError: "Admin shell e2e failure",
    });

  return admin.id;
}

async function installAdminSession(page: Page, adminId: string) {
  const token = generateSessionToken();
  await getDb()
    .insert(sessions)
    .values({
      userId: adminId,
      tokenHash: hmacSha256(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ip: "127.0.0.1",
      userAgent: "admin-shell-e2e",
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

async function expectNoDocumentOverflow(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      })),
    )
    .toMatchObject({ scrollWidth: expect.any(Number), clientWidth: expect.any(Number) });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth > window.innerWidth + 1 ||
      document.body.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function assertShellWidthSmoke(page: Page, width: number, route: string) {
  await page.setViewportSize({ width, height: width >= 768 ? 900 : 720 });
  await page.goto(route);
  await expect(page.locator("h1")).toBeVisible();
  await expectNoDocumentOverflow(page);
  const mainWidth = await page.getByTestId("admin-main").evaluate((element) => element.clientWidth);
  if (width < 1024) {
    expect(mainWidth).toBeGreaterThanOrEqual(width - 2);
  } else {
    expect(mainWidth).toBeGreaterThan(0);
  }
  const tableContainers = page.locator('[data-slot="table-container"]');
  const mobileCards = page.locator('[data-slot="admin-mobile-data-card"]');
  if (width < 768 && (await mobileCards.count()) > 0) {
    await expect(mobileCards.first()).toBeVisible();
    await expect(tableContainers.first()).toBeHidden();
  } else {
    for (const table of await tableContainers.all()) {
      await expect(table).toBeVisible();
      await expect(table).toHaveCSS("overflow-x", "auto");
    }
  }
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
  await installAdminSession(
    page,
    (
      await getDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, ADMIN_EMAIL))
        .limit(1)
    )[0]!.id,
  );
});

test("desktop sidebar is visible and marks the current page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/posts");

  await expect(page.getByTestId("admin-desktop-sidebar")).toBeVisible();
  await expect(page.getByTestId("admin-mobile-menu-button")).toBeHidden();
  await expect(page.locator('aside a[aria-current="page"]')).toHaveText("内容管理");
  await expect(page.locator('aside [data-admin-nav-group="content"] p')).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectNoDocumentOverflow(page);
});

test("settings page explains configuration source and saved test semantics on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/admin/settings");

  await expect(page.getByTestId("admin-config-source-summary").first()).toBeVisible();
  await expect(page.getByText("当前来源").first()).toBeVisible();
  await expect(page.getByText("从环境变量导入只会填入表单，不会立即保存。").first()).toBeVisible();
  await expect(
    page.getByText("连接测试使用已保存的有效配置，而不是当前未保存的表单内容。").first(),
  ).toBeVisible();
  await expect(page.getByText("此集成没有环境变量回退", { exact: false }).first()).toBeVisible();
  await expect(page.getByLabel("SMTP 主机")).toBeVisible();
  await expect(page.getByLabel("端口")).toBeVisible();
  await expect(page.getByLabel("内容附件上限（MB）")).toHaveAttribute(
    "aria-describedby",
    /max-upload-size-description/,
  );
  await expect(page.locator("#max-upload-size-description")).toContainText("环境变量默认");
  await expectNoDocumentOverflow(page);
});

test("site settings stack controls and keep every field reachable on narrow screens", async ({
  page,
}) => {
  test.setTimeout(120_000);

  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/admin/site");

    await expect(page.getByTestId("site-settings-form")).toBeVisible();
    await expect(page.getByLabel("站点名称")).toBeVisible();
    await expect(page.getByLabel("画师头像")).toBeVisible();
    await expect(page.getByLabel("链接地址")).toHaveValue(
      "https://example.com/admin-shell-social-link-with-a-very-long-unbroken-mobile-value",
    );

    const row = page.getByTestId("site-social-link-row").first();
    const nameBox = await row.getByLabel("平台名称").boundingBox();
    const urlBox = await row.getByLabel("链接地址").boundingBox();
    const deleteBox = await row.getByRole("button", { name: "删除" }).boundingBox();
    expect(nameBox).not.toBeNull();
    expect(urlBox).not.toBeNull();
    expect(deleteBox).not.toBeNull();
    expect(urlBox!.y).toBeGreaterThan(nameBox!.y + nameBox!.height);
    expect(deleteBox!.y).toBeGreaterThan(urlBox!.y + urlBox!.height);

    const formWidth = await page
      .getByTestId("site-settings-form")
      .evaluate((element) => element.getBoundingClientRect().width);
    const saveWidth = await page
      .getByRole("button", { name: "保存设置" })
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(saveWidth).toBeGreaterThanOrEqual(formWidth - 1);

    const formMetrics = await page.getByTestId("site-settings-form").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        left: bounds.left,
        right: bounds.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(formMetrics.scrollWidth).toBeLessThanOrEqual(formMetrics.clientWidth + 1);
    expect(formMetrics.left).toBeGreaterThanOrEqual(-1);
    expect(formMetrics.right).toBeLessThanOrEqual(formMetrics.viewportWidth + 1);

    const mainMetrics = await page.getByTestId("admin-main").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        left: bounds.left,
        right: bounds.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(mainMetrics.scrollWidth).toBeLessThanOrEqual(mainMetrics.clientWidth + 1);
    expect(mainMetrics.left).toBeGreaterThanOrEqual(-1);
    expect(mainMetrics.right).toBeLessThanOrEqual(mainMetrics.viewportWidth + 1);

    for (const testId of ["site-logo-preview", "site-icon-preview"]) {
      const preview = page.getByTestId(testId);
      await expect(preview).toBeVisible();
      await expect
        .poll(() =>
          preview.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      const previewWidths = await preview.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(previewWidths.scrollWidth).toBeLessThanOrEqual(previewWidths.clientWidth + 1);
    }
    const clearLogo = page.getByRole("button", { name: "清除 Logo" });
    const clearIcon = page.getByRole("button", { name: "清除 Icon" });
    await clearLogo.focus();
    await expect(clearLogo).toBeFocused();
    await clearIcon.focus();
    await expect(clearIcon).toBeFocused();

    for (const input of await page.locator('input[type="file"]').all()) {
      const widths = await input.evaluate((element) => ({
        input: element.getBoundingClientRect().width,
        parent: element.parentElement?.getBoundingClientRect().width ?? 0,
      }));
      expect(widths.input).toBeLessThanOrEqual(widths.parent + 1);
    }
    await expectNoDocumentOverflow(page);
  }
});

test("post editor stacks fields, files, and actions without narrow-screen overflow", async ({
  page,
}) => {
  test.setTimeout(120_000);

  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/admin/posts/${seededPostId}`);

    const editor = page.getByTestId("post-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("标题", { exact: true })).toBeVisible();
    await expect(page.getByLabel("slug（URL 标识，小写字母数字连字符）")).toBeVisible();
    await expect(editor.getByLabel("正文", { exact: true })).toBeVisible();
    await expect(page.getByLabel("可见性")).toBeVisible();
    await expect(page.getByLabel("所需会员等级（及以上）")).toBeVisible();
    await expect(page.getByLabel("封面（公开可见）")).toBeVisible();
    await expect(page.getByLabel("译文语言")).toBeVisible();

    const titleRow = page.getByTestId("post-editor-title-row");
    const titleBox = await titleRow.getByLabel("标题").boundingBox();
    const slugBox = await titleRow.getByLabel("slug（URL 标识，小写字母数字连字符）").boundingBox();
    expect(titleBox).not.toBeNull();
    expect(slugBox).not.toBeNull();
    expect(slugBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height);

    const actions = page.getByTestId("post-editor-actions");
    const actionWidth = await actions.evaluate((element) => element.getBoundingClientRect().width);
    for (const button of await actions.locator(":scope > button").all()) {
      const buttonWidth = await button.evaluate((element) => element.getBoundingClientRect().width);
      expect(buttonWidth).toBeGreaterThanOrEqual(actionWidth - 1);
    }

    const attachedFile = page.getByTestId("post-editor-attached-file").first();
    await expect(attachedFile).toContainText(
      "admin-shell-e2e-long-file-name-for-mobile-card-responsive-checks.png",
    );
    const removeBox = await attachedFile.getByRole("button", { name: "移除" }).boundingBox();
    const attachedContentWidth = await attachedFile.evaluate((element) => {
      const styles = window.getComputedStyle(element);
      return (
        element.clientWidth -
        Number.parseFloat(styles.paddingLeft) -
        Number.parseFloat(styles.paddingRight)
      );
    });
    expect(removeBox).not.toBeNull();
    expect(removeBox!.width).toBeGreaterThanOrEqual(attachedContentWidth - 1);

    for (const markdownEditor of await page.getByTestId("markdown-editor").all()) {
      const widths = await markdownEditor.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
    }
    if (width === 320) {
      const videoInputIds: string[] = [];
      for (const markdownEditor of await page.getByTestId("markdown-editor").all()) {
        await markdownEditor.getByRole("button", { name: "插入公开视频" }).click();
        const dialog = page.getByRole("dialog");
        const videoInput = dialog.getByLabel("视频 URL");
        await expect(videoInput).toBeVisible();
        const videoInputId = await videoInput.getAttribute("id");
        expect(videoInputId).not.toBeNull();
        videoInputIds.push(videoInputId!);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }
      expect(new Set(videoInputIds).size).toBe(videoInputIds.length);
    }
    for (const input of await page.locator('input[type="file"]:visible').all()) {
      const widths = await input.evaluate((element) => ({
        input: element.getBoundingClientRect().width,
        parent: element.parentElement?.getBoundingClientRect().width ?? 0,
      }));
      expect(widths.input).toBeLessThanOrEqual(widths.parent + 1);
    }

    for (const testId of ["post-editor", "admin-main"]) {
      const metrics = await page.getByTestId(testId).evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          left: bounds.left,
          right: bounds.right,
          viewportWidth: window.innerWidth,
        };
      });
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
      expect(metrics.left).toBeGreaterThanOrEqual(-1);
      expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    }
    await expectNoDocumentOverflow(page);
  }
});

test("mobile drawer opens, traps focus, closes with Escape, and restores focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/admin/payments/reviews");

  const trigger = page.getByTestId("admin-mobile-menu-button");
  await expect(trigger).toBeVisible();
  await expect(page.getByTestId("admin-desktop-sidebar")).toBeHidden();
  await trigger.click();
  const drawer = page.getByTestId("admin-mobile-nav");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('a[aria-current="page"]')).toHaveText("付款审核");

  for (let i = 0; i < 8; i += 1) await page.keyboard.press("Tab");
  expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("mobile drawer closes after route navigation and nested pages activate their parent item", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/admin/posts/new");
  await page.getByTestId("admin-mobile-menu-button").click();
  await expect(page.getByTestId("admin-mobile-nav").locator('a[aria-current="page"]')).toHaveText(
    "内容管理",
  );
  await page.getByRole("link", { name: "文件管理" }).click();
  await expect(page).toHaveURL(/\/admin\/files$/);
  await expect(page.getByTestId("admin-mobile-nav")).toBeHidden();
});

test("mobile drawer constrains the nav pane and keeps account actions reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 568 });
  await page.goto("/admin/tasks");
  await page.getByTestId("admin-mobile-menu-button").click();

  const drawer = page.getByTestId("admin-mobile-nav");
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveCSS("display", "flex");
  await expect(drawer).toHaveCSS("flex-direction", "column");

  const navPane = page.getByTestId("admin-mobile-nav-scroll");
  await expect(navPane).toHaveCSS("overflow-y", "auto");
  const navPaneMetrics = await navPane.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(navPaneMetrics.clientHeight).toBeGreaterThan(0);
  expect(navPaneMetrics.scrollHeight).toBeGreaterThan(navPaneMetrics.clientHeight);

  await expect(page.getByTestId("admin-mobile-account-actions")).toBeVisible();
});

test("mobile drawer closes without restoring focus to hidden trigger when resized to desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/admin/tasks");
  const trigger = page.getByTestId("admin-mobile-menu-button");
  await trigger.click();
  await expect(page.getByTestId("admin-mobile-nav")).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 768 });

  await expect(page.getByTestId("admin-mobile-nav")).toBeHidden();
  await expect(page.getByTestId("admin-mobile-menu-button")).toBeHidden();
  await expect(page.getByTestId("admin-desktop-sidebar")).toBeVisible();
  expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(false);
  await expectNoDocumentOverflow(page);
});

test("view site performs a full document navigation and loads public integrations", async ({
  page,
}) => {
  let integrationScriptRequested = false;
  await page.route(`${PUBLIC_INTEGRATION_ORIGIN}/**`, async (route) => {
    integrationScriptRequested = true;
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.__adminShellPublicIntegrationLoaded = true;",
    });
  });
  await upsertSetting("public_integrations", [
    {
      id: "admin-shell-public-integration",
      provider: "custom",
      enabled: true,
      placement: "head",
      src: PUBLIC_INTEGRATION_SCRIPT_URL,
      data: {},
      csp: { script: [PUBLIC_INTEGRATION_ORIGIN], image: [], connect: [], frame: [] },
    },
  ]);
  await upsertSetting("public_csp_revision", `admin-shell-e2e-${Date.now()}`);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin");
  const publicDocumentResponsePromise = page.waitForResponse(
    (response) =>
      response.request().resourceType() === "document" && new URL(response.url()).pathname === "/",
  );

  await page.getByTestId("admin-view-site-link").click();

  const publicDocumentResponse = await publicDocumentResponsePromise;
  const publicPolicy =
    publicDocumentResponse.headers()["content-security-policy"] ??
    publicDocumentResponse.headers()["content-security-policy-report-only"];
  expect(publicPolicy).toContain(PUBLIC_INTEGRATION_ORIGIN);
  await expect.poll(() => integrationScriptRequested).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __adminShellPublicIntegrationLoaded?: boolean })
            .__adminShellPublicIntegrationLoaded,
      ),
    )
    .toBe(true);
});

test("skip link moves focus to the main content", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/posts");
  await page.keyboard.press("Tab");
  await expect(page.getByText("跳到主内容")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("admin-main")).toBeFocused();
});

test("admin shell gives six representative pages full mobile/tablet width without document overflow", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const routes = [
    "/admin/payments/reviews",
    "/admin/posts",
    "/admin/files",
    "/admin/settings",
    "/admin/site",
    "/admin/tasks",
  ];
  for (const width of [320, 390, 768, 1024, 1440]) {
    for (const route of routes) {
      await assertShellWidthSmoke(page, width, route);
      if (width < 1024) {
        await expect(page.getByTestId("admin-mobile-menu-button")).toBeVisible();
        await expect(page.getByTestId("admin-desktop-sidebar")).toBeHidden();
      } else {
        await expect(page.getByTestId("admin-mobile-menu-button")).toBeHidden();
        await expect(page.getByTestId("admin-desktop-sidebar")).toBeVisible();
      }
    }
  }
});

test("representative admin tables switch to mobile cards below md", async ({ page }) => {
  test.setTimeout(120_000);
  const routes = [
    "/admin/payments/reviews",
    "/admin/posts",
    "/admin/files",
    "/admin/tasks",
    "/admin/users",
    "/admin/memberships",
    "/admin/downloads",
    "/admin/notifications",
  ];

  for (const route of routes) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    await expectNoDocumentOverflow(page);
    await expect(page.locator('[data-slot="admin-mobile-data-card"]').first()).toBeVisible();
    await expect(page.locator('[data-slot="table-container"]').first()).toBeHidden();
    if (route === "/admin/tasks") {
      await expect(page.getByLabel(/^尝试次数: \d+ \/ \d+$/).first()).toBeVisible();
    }

    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    await expectNoDocumentOverflow(page);
    await expect(page.locator('[data-slot="table-container"]').first()).toBeVisible();
  }
});

test("notification campaigns remain usable at narrow widths and expose diagnostics by keyboard", async ({
  page,
}) => {
  test.setTimeout(120_000);

  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/admin/notifications");
    await expectNoDocumentOverflow(page);

    const card = page.locator('[data-slot="admin-mobile-data-card"]').first();
    await expect(card).toBeVisible();
    await expect(page.locator('[data-slot="table-container"]').first()).toBeHidden();
    await expect(card.getByText("已终止", { exact: true })).toBeVisible();
    await expect(card.getByText("定时发布", { exact: true })).toBeVisible();
    await expect(card).not.toContainText("scheduled_publish");
  }

  const diagnostics = page.locator('[data-slot="admin-mobile-data-card"] details').first();
  const summary = diagnostics.locator("summary");
  await summary.focus();
  await expect(summary).toBeFocused();
  await summary.press("Enter");
  await expect(diagnostics).toHaveAttribute("open", "");
  await expect(diagnostics).toContainText("扩展游标用户 ID");

  const errorDetails = page.locator('[data-slot="admin-mobile-data-card"] details').nth(1);
  await errorDetails.locator("summary").press("Enter");
  await expect(errorDetails).toHaveAttribute("open", "");
  await expect(errorDetails).toContainText("Admin-shell-notification-error-with-a-very-long");
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/admin/notifications");
  await expect(page.locator('[data-slot="table-container"]').first()).toBeVisible();
  await expect(page.locator('[data-slot="admin-mobile-data-card"]').first()).toBeHidden();
  await expectNoDocumentOverflow(page);
});
