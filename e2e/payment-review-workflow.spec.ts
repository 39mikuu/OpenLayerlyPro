import { expect, type Page, test } from "@playwright/test";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import { membershipTiers, paymentRequests, sessions, siteSettings, users } from "../src/db/schema";
import { generateSessionToken, hmacSha256 } from "../src/lib/crypto";
import { SESSION_COOKIE } from "../src/modules/auth/session";
import { LOCALE_COOKIE } from "../src/modules/i18n/config";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const ADMIN_EMAIL = "admin-payment-review-e2e@example.com";
const MEMBER_EMAIL = "member-payment-review-e2e@example.com";
const TIER_SLUG = "payment-review-e2e-tier";
const LONG_NOTE = Array.from(
  { length: 20 },
  (_, index) => `Long payment review note segment ${index + 1}`,
).join(" · ");
const SEEDED_SETTING_KEYS = [
  "initialized",
  "site_name",
  "artist_name",
  "artist_bio",
  "social_links",
] as const;

type SiteSettingsSnapshot = Map<string, unknown>;
let originalSiteSettings: SiteSettingsSnapshot | null = null;

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
      ${paymentRequests.userId} in (select id from users where email in (${ADMIN_EMAIL}, ${MEMBER_EMAIL}))
      or ${paymentRequests.tierId} in (select id from membership_tiers where slug = ${TIER_SLUG})
    `);
    await tx
      .delete(sessions)
      .where(sql`${sessions.userId} in (select id from users where email = ${ADMIN_EMAIL})`);
    await tx.delete(users).where(sql`${users.email} in (${ADMIN_EMAIL}, ${MEMBER_EMAIL})`);
    await tx.delete(membershipTiers).where(eq(membershipTiers.slug, TIER_SLUG));
    await tx.delete(siteSettings).where(inArray(siteSettings.key, [...SEEDED_SETTING_KEYS]));
  });
}

async function seedFixtures() {
  await cleanupFixtures();
  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "Payment Review E2E");
  await upsertSetting("artist_name", "Payment Review Artist");
  await upsertSetting("artist_bio", "Payment review workflow fixtures.");
  await upsertSetting("social_links", []);

  const [admin] = await getDb()
    .insert(users)
    .values({ email: ADMIN_EMAIL, role: "admin", displayName: "Payment Review Admin" })
    .returning({ id: users.id });
  const [member] = await getDb()
    .insert(users)
    .values({ email: MEMBER_EMAIL, role: "member", displayName: "Payment Review Member" })
    .returning({ id: users.id });
  const [tier] = await getDb()
    .insert(membershipTiers)
    .values({
      name: "Payment Review Tier",
      slug: TIER_SLUG,
      priceLabel: "$99 / month",
      level: 20,
      durationDays: 31,
      purchaseEnabled: true,
      isActive: true,
      sortOrder: 1,
    })
    .returning({ id: membershipTiers.id });

  await getDb().insert(paymentRequests).values({
    userId: member.id,
    tierId: tier.id,
    status: "pending_review",
    flow: "manual",
    amountLabel: "$99 / month",
    durationDays: 31,
    note: LONG_NOTE,
  });

  return admin.id;
}

function seededPaymentReviewRow(page: Page) {
  return page
    .locator('[data-slot="admin-mobile-data-card"]')
    .filter({ hasText: MEMBER_EMAIL })
    .filter({ hasText: LONG_NOTE });
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
      userAgent: "payment-review-e2e",
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
  const [admin] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  await installAdminSession(page, admin!.id);
});

test("reject dialog remains usable on mobile with a long note", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/payments/reviews");
  const row = seededPaymentReviewRow(page);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Reject" }).click();

  const dialog = page.getByRole("dialog", { name: "Reject payment request" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("overflow-y", "auto");

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(844);
  await expect(dialog.getByText(LONG_NOTE)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Reject request" })).toBeVisible();
});

test("approve dialog does not expose reject action while closing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/payments/reviews");
  const row = seededPaymentReviewRow(page);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Approve" }).click();

  const dialog = page.getByRole("dialog", { name: "Approve payment request" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const sawRejectActionWhileClosing = await page.evaluate(async () => {
    function hasRejectRequestButton() {
      return Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Reject request",
      );
    }

    for (let index = 0; index < 12; index += 1) {
      if (hasRejectRequestButton()) return true;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
  });

  expect(sawRejectActionWhileClosing).toBe(false);
});

test("reject dialog cannot be dismissed while the review request is pending", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/payments/reviews");
  const row = seededPaymentReviewRow(page);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Reject" }).click();

  const dialog = page.getByRole("dialog", { name: "Reject payment request" });
  await expect(dialog).toBeVisible();

  let releaseRejectRequest!: () => void;
  const rejectRequestStarted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/admin\/payment-requests\/[^/]+\/reject$/.test(new URL(request.url()).pathname),
  );
  await page.route(/\/api\/admin\/payment-requests\/[^/]+\/reject$/, async (route) => {
    await new Promise<void>((resolve) => {
      releaseRejectRequest = resolve;
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: {} }),
    });
  });

  await dialog.getByRole("button", { name: "Reject request" }).click();
  await rejectRequestStarted;
  await expect(dialog.getByRole("button", { name: "Rejecting..." })).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);

  releaseRejectRequest();
  await expect(dialog).toBeHidden();
});

test("sends a stable reject reason code instead of the administrator locale text", async ({
  page,
}) => {
  await page
    .context()
    .addCookies([{ name: LOCALE_COOKIE, value: "ja", url: BASE_URL, sameSite: "Lax" }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/payments/reviews");
  const row = seededPaymentReviewRow(page);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "却下" }).click();

  const dialog = page.getByRole("dialog", { name: "支払い申請を却下" });
  await expect(dialog).toBeVisible();

  let requestBody: unknown;
  await page.route(/\/api\/admin\/payment-requests\/[^/]+\/reject$/, async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: {} }),
    });
  });

  await dialog.getByRole("button", { name: "申請を却下" }).click();

  await expect
    .poll(() => requestBody)
    .toEqual({
      rejectReasonCode: "proof_unclear",
      rejectDetails: null,
    });
  expect(JSON.stringify(requestBody)).not.toContain("支払い証明");
});
