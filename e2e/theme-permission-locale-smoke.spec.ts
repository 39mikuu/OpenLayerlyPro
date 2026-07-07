import { expect, type Page, test } from "@playwright/test";
import { eq, inArray, like, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import {
  memberships,
  membershipTiers,
  posts,
  postTranslations,
  sessions,
  siteSettings,
  users,
} from "../src/db/schema";
import { generateSessionToken, hashPassword, hmacSha256 } from "../src/lib/crypto";
import { SESSION_COOKIE } from "../src/modules/auth/session";
import { type Locale, LOCALE_COOKIE } from "../src/modules/i18n/config";
import { en } from "../src/modules/i18n/messages/en";
import { ja } from "../src/modules/i18n/messages/ja";
import { zh } from "../src/modules/i18n/messages/zh";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const ACTIVE_THEME_SETTING_KEY = "theme";
const THEME_CONFIG_SETTING_KEY = "theme_config";

const ADMIN_EMAIL = "blog-theme-admin@example.com";
const ADMIN_PASSWORD = "blog-theme-admin-password";
const PUBLIC_SLUG = "blog-theme-public-smoke";
const LOGIN_SLUG = "blog-theme-login-smoke";
const MEMBER_SLUG = "blog-theme-member-smoke";
const PUBLIC_TITLE = "Blog Theme Public Smoke";
const LOGIN_TITLE = "Blog Theme Login Smoke";
const MEMBER_TITLE = "Blog Theme Member Smoke";
const PUBLIC_BODY = "Public body visible under the blog theme.";
const LOGIN_BODY = "Login gated body visible only after session preflight.";
const MEMBER_BODY = "Member gated body visible only with an active tier entitlement.";
const MEMBER_TIER_NAME = "Smoke Supporter";

const localeCases: ReadonlyArray<{
  locale: Locale;
  publicText: string;
  publicTitle: string;
  themeLabel: string;
  themeHelp: string;
}> = [
  {
    locale: "zh",
    publicText: zh.posts.subtitle,
    publicTitle: "博客主题公开 Smoke",
    themeLabel: zh.admin.site.theme,
    themeHelp: zh.admin.site.themeHelp,
  },
  {
    locale: "en",
    publicText: en.posts.subtitle,
    publicTitle: PUBLIC_TITLE,
    themeLabel: en.admin.site.theme,
    themeHelp: en.admin.site.themeHelp,
  },
  {
    locale: "ja",
    publicText: ja.posts.subtitle,
    publicTitle: "ブログテーマ公開 Smoke",
    themeLabel: ja.admin.site.theme,
    themeHelp: ja.admin.site.themeHelp,
  },
];

async function upsertSetting(key: string, valueJson: unknown) {
  await getDb()
    .insert(siteSettings)
    .values({ key, valueJson })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { valueJson, updatedAt: new Date() },
    });
}

async function seedUser(input: { email: string; role: "admin" | "member" }) {
  const [user] = await getDb()
    .insert(users)
    .values({
      email: input.email,
      role: input.role,
      displayName: input.email,
      passwordHash: input.role === "admin" ? await hashPassword(ADMIN_PASSWORD) : null,
    })
    .returning({ id: users.id, email: users.email, role: users.role });
  return user;
}

async function seedSession(page: Page, input: { email: string; role: "member" }) {
  const user = await seedUser(input);
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await getDb()
    .insert(sessions)
    .values({
      userId: user.id,
      tokenHash: hmacSha256(token),
      expiresAt,
      ip: "127.0.0.1",
      userAgent: "blog-theme-smoke",
    });

  // Local e2e uses plain loopback HTTP, so install the token without Secure.
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      url: BASE_URL,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  const preflight = await page.request.get("/api/auth/me");
  expect(preflight.ok(), `seeded session preflight failed: ${await preflight.text()}`).toBe(true);
  await expect(preflight.json()).resolves.toMatchObject({
    ok: true,
    data: { id: user.id, email: user.email, role: user.role },
  });

  return user;
}

async function seedAdminSessionViaLogin(page: Page, email: string) {
  const user = await seedUser({ email, role: "admin" });
  const loginResponse = await page.request.post("/api/auth/admin/login", {
    data: { email, password: ADMIN_PASSWORD },
  });
  expect(loginResponse.ok(), await loginResponse.text()).toBe(true);
  const setCookie = loginResponse.headers()["set-cookie"];
  expect(setCookie).toContain(SESSION_COOKIE);
  const sessionCookie = setCookie.match(/^([^=]+)=([^;]+)/);
  expect(sessionCookie).not.toBeNull();

  // The production cookie is correctly Secure. Local e2e uses plain loopback HTTP,
  // so install the same token without Secure for transport.
  await page.context().addCookies([
    {
      name: sessionCookie![1],
      value: sessionCookie![2],
      url: BASE_URL,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  const preflight = await page.request.get("/api/auth/me");
  expect(preflight.ok(), `admin login preflight failed: ${await preflight.text()}`).toBe(true);
  await expect(preflight.json()).resolves.toMatchObject({
    ok: true,
    data: { id: user.id, email: user.email, role: "admin" },
  });

  return user;
}

async function seedFixtures() {
  const db = getDb();
  await db.transaction(async (tx) => {
    const fixtureSlugs = [PUBLIC_SLUG, LOGIN_SLUG, MEMBER_SLUG];
    const fixtureTierSlug = "blog-theme-smoke-supporter";

    await tx
      .delete(memberships)
      .where(
        sql`${memberships.userId} in (select id from users where email like 'blog-theme-%@example.com')`,
      );
    await tx
      .delete(sessions)
      .where(
        sql`${sessions.userId} in (select id from users where email like 'blog-theme-%@example.com')`,
      );
    await tx.delete(postTranslations).where(
      sql`${postTranslations.postId} in (select id from posts where slug in (${sql.join(
        fixtureSlugs.map((slug) => sql`${slug}`),
        sql`, `,
      )}))`,
    );
    await tx.delete(posts).where(inArray(posts.slug, fixtureSlugs));
    await tx.delete(membershipTiers).where(eq(membershipTiers.slug, fixtureTierSlug));
    await tx.delete(users).where(like(users.email, "blog-theme-%@example.com"));
    await tx
      .delete(siteSettings)
      .where(
        inArray(siteSettings.key, [
          "artist_avatar_file_id",
          "site_logo_file_id",
          "site_icon_file_id",
        ]),
      );
  });

  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "Blog Theme Smoke Site");
  await upsertSetting("artist_name", "Blog Theme Smoke Artist");
  await upsertSetting("artist_bio", "Functional smoke fixtures for the blog theme.");
  await upsertSetting("social_links", []);
  // s6-security-headers.spec.ts (runs before this file) intentionally leaves public
  // integrations/footer/CSP settings mutated (a mock script-injection integration,
  // legacy footer markup). Reset them so this spec's pages aren't running against
  // stale cross-file state - mirrors theme-visual-baseline.spec.ts's own reset.
  await upsertSetting("custom_footer_markup", "");
  await upsertSetting("custom_footer_html", "");
  await upsertSetting("site_verification", []);
  await upsertSetting("public_integrations", []);
  await upsertSetting("public_csp_revision", "theme-permission-locale-smoke");
  await upsertSetting(ACTIVE_THEME_SETTING_KEY, "blog");
  await upsertSetting(THEME_CONFIG_SETTING_KEY, {
    builtin: { colorPreset: "blue" },
    blog: { colorPreset: "ink" },
  });

  const [tier] = await db
    .insert(membershipTiers)
    .values({
      name: MEMBER_TIER_NAME,
      slug: "blog-theme-smoke-supporter",
      description: "Tier used by blog-theme permission smoke tests.",
      priceLabel: "$9 / month",
      level: 20,
      durationDays: 31,
      purchaseEnabled: true,
      isActive: false,
      sortOrder: 1,
    })
    .returning({ id: membershipTiers.id });

  const fixedPublishedAt = new Date("2026-01-15T08:00:00.000Z");
  const [publicPost] = await db
    .insert(posts)
    .values({
      title: PUBLIC_TITLE,
      slug: PUBLIC_SLUG,
      summary: "Public blog theme smoke summary.",
      body: PUBLIC_BODY,
      originalLocale: "en",
      visibility: "public",
      status: "published",
      publishedAt: fixedPublishedAt,
    })
    .returning({ id: posts.id });
  await db.insert(postTranslations).values([
    {
      postId: publicPost.id,
      locale: "zh",
      title: "博客主题公开 Smoke",
      summary: "中文公开页面 smoke 摘要。",
      body: "中文公开页面 smoke 正文。",
      status: "published",
      source: "manual",
      publishedAt: fixedPublishedAt,
    },
    {
      postId: publicPost.id,
      locale: "ja",
      title: "ブログテーマ公開 Smoke",
      summary: "日本語公開ページ smoke の概要。",
      body: "日本語公開ページ smoke の本文。",
      status: "published",
      source: "manual",
      publishedAt: fixedPublishedAt,
    },
  ]);

  await db.insert(posts).values([
    {
      title: LOGIN_TITLE,
      slug: LOGIN_SLUG,
      summary: "Login gated smoke summary.",
      body: LOGIN_BODY,
      originalLocale: "en",
      visibility: "login",
      status: "published",
      publishedAt: fixedPublishedAt,
    },
    {
      title: MEMBER_TITLE,
      slug: MEMBER_SLUG,
      summary: "Member gated smoke summary.",
      body: MEMBER_BODY,
      originalLocale: "en",
      visibility: "member",
      requiredTierId: tier.id,
      status: "published",
      publishedAt: fixedPublishedAt,
    },
  ]);
}

test.describe.serial("blog theme functional permission and locale smoke", () => {
  test.beforeAll(async () => {
    await seedFixtures();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test("keeps public content visible for anonymous visitors", async ({ page, context }) => {
    await context.addCookies([{ name: LOCALE_COOKIE, value: "en", url: BASE_URL }]);
    const response = await page.goto(`/posts/${PUBLIC_SLUG}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: PUBLIC_TITLE })).toBeVisible();
    await expect(page.getByText(PUBLIC_BODY)).toBeVisible();
  });

  test("keeps login-gated post body hidden from anonymous visitors and visible to signed-in users", async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: LOCALE_COOKIE, value: "en", url: BASE_URL }]);
    await page.goto(`/posts/${LOGIN_SLUG}`);
    await expect(page.getByRole("heading", { name: LOGIN_TITLE })).toBeVisible();
    await expect(page.getByText(LOGIN_BODY)).toBeHidden();
    await expect(page.getByText(en.post.lockedLogin)).toBeVisible();

    await seedSession(page, { email: "blog-theme-login-user@example.com", role: "member" });
    await page.goto(`/posts/${LOGIN_SLUG}`);
    await expect(page.getByText(LOGIN_BODY)).toBeVisible();
    await expect(page.getByText(en.post.lockedLogin)).toBeHidden();
  });

  test("keeps member-gated post body hidden from non-members and visible to active members", async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: LOCALE_COOKIE, value: "en", url: BASE_URL }]);
    await seedSession(page, { email: "blog-theme-non-member@example.com", role: "member" });
    await page.goto(`/posts/${MEMBER_SLUG}`);
    await expect(page.getByRole("heading", { name: MEMBER_TITLE })).toBeVisible();
    await expect(page.getByText(MEMBER_BODY)).toBeHidden();
    await expect(
      page.getByText(en.post.lockedMember.replace("{tier}", MEMBER_TIER_NAME)),
    ).toBeVisible();

    const activeMember = await seedSession(page, {
      email: "blog-theme-active-member@example.com",
      role: "member",
    });
    const [tier] = await getDb()
      .select({ id: membershipTiers.id })
      .from(membershipTiers)
      .where(eq(membershipTiers.slug, "blog-theme-smoke-supporter"))
      .limit(1);
    expect(tier).toBeTruthy();
    await getDb()
      .insert(memberships)
      .values({
        userId: activeMember.id,
        tierId: tier.id,
        source: "manual",
        status: "active",
        startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        note: "Blog theme smoke active membership",
      });

    await page.goto(`/posts/${MEMBER_SLUG}`);
    await expect(page.getByText(MEMBER_BODY)).toBeVisible();
    await expect(page.getByText(en.post.lockedTitle)).toBeHidden();
  });

  test("keeps admin-only API decisions unchanged under the blog theme", async ({ page }) => {
    const anonymousResponse = await page.request.get("/api/admin/theme");
    expect(anonymousResponse.status()).toBe(401);

    await seedSession(page, { email: "blog-theme-admin-denied@example.com", role: "member" });
    const memberResponse = await page.request.get("/api/admin/theme");
    expect(memberResponse.status()).toBe(403);

    await seedAdminSessionViaLogin(page, ADMIN_EMAIL);
    const adminResponse = await page.request.get("/api/admin/theme");
    expect(adminResponse.ok(), await adminResponse.text()).toBe(true);
    await expect(adminResponse.json()).resolves.toMatchObject({
      ok: true,
      data: { activeTheme: "blog" },
    });
  });

  for (const { locale, publicText, publicTitle, themeLabel, themeHelp } of localeCases) {
    test(`renders public and admin theme-selector smoke text in ${locale}`, async ({
      page,
      context,
    }) => {
      await context.addCookies([{ name: LOCALE_COOKIE, value: locale, url: BASE_URL }]);
      await page.goto("/posts");
      await expect(page.getByText(publicText)).toBeVisible();
      await expect(page.getByText(publicTitle)).toBeVisible();

      await seedAdminSessionViaLogin(page, `blog-theme-admin-${locale}@example.com`);
      await context.addCookies([{ name: LOCALE_COOKIE, value: locale, url: BASE_URL }]);
      await page.goto("/admin/site");
      await expect(page.getByLabel(themeLabel)).toBeVisible();
      await expect(page.getByText(themeHelp)).toBeVisible();
    });
  }
});
