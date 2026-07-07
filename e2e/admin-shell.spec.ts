import { expect, type Page, test } from "@playwright/test";
import { eq, inArray, like, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import {
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
import { LOCALE_COOKIE } from "../src/modules/i18n/config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const ADMIN_EMAIL = "admin-shell-e2e@example.com";
const MEMBER_EMAIL = "admin-shell-member@example.com";
const POST_SLUG = "admin-shell-e2e-post";
const TIER_SLUG = "admin-shell-e2e-tier";
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
      ${paymentRequests.userId} in (select id from users where email like 'admin-shell-%@example.com')
      or ${paymentRequests.tierId} in (select id from membership_tiers where slug = ${TIER_SLUG})
    `);
    await tx
      .delete(sessions)
      .where(
        sql`${sessions.userId} in (select id from users where email like 'admin-shell-%@example.com')`,
      );
    await tx.delete(posts).where(eq(posts.slug, POST_SLUG));
    await tx.delete(tasks).where(like(tasks.dedupeKey, "admin-shell-e2e%"));
    await tx.delete(users).where(like(users.email, "admin-shell-%@example.com"));
    await tx.delete(membershipTiers).where(eq(membershipTiers.slug, TIER_SLUG));
    await tx.delete(siteSettings).where(inArray(siteSettings.key, [...SEEDED_SETTING_KEYS]));
  });
}

async function seedFixtures() {
  await cleanupFixtures();

  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "Admin Shell E2E");
  await upsertSetting("artist_name", "Admin Shell Artist");
  await upsertSetting("artist_bio", "Admin shell responsive fixtures.");
  await upsertSetting("social_links", []);
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

  await getDb().insert(posts).values({
    title: "Admin Shell E2E Long Post Title For Responsive Checks",
    slug: POST_SLUG,
    summary: "Admin shell responsive post summary.",
    body: "Admin shell responsive post body.",
    originalLocale: "en",
    visibility: "public",
    status: "draft",
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
  for (const table of await page.locator('[data-slot="table-container"]').all()) {
    await expect(table).toBeVisible();
    await expect(table).toHaveCSS("overflow-x", "auto");
  }
}

test.beforeAll(async () => {
  await seedFixtures();
});

test.afterAll(async () => {
  try {
    await cleanupFixtures();
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

test("skip link moves focus to the main content", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/posts");
  await page.keyboard.press("Tab");
  await expect(page.getByText("跳到主内容")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("admin-main")).toBeFocused();
});

test("admin shell gives five representative pages full mobile/tablet width without document overflow", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const routes = [
    "/admin/payments/reviews",
    "/admin/posts",
    "/admin/files",
    "/admin/settings",
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
