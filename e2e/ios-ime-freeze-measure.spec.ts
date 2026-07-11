import { expect, type Page, test } from "@playwright/test";
import { eq, inArray, like, sql } from "drizzle-orm";

import { closeDb, getDb } from "../src/db";
import { posts, sessions, siteSettings, users } from "../src/db/schema";
import { generateSessionToken, hmacSha256 } from "../src/lib/crypto";
import { SESSION_COOKIE } from "../src/modules/auth/session";
import { LOCALE_COOKIE } from "../src/modules/i18n/config";

// Investigative measurement harness for the reported iOS Safari Chinese-IME
// editor freeze. This is NOT a pass/fail regression test — it collects
// timing/structural metrics printed to stdout for manual comparison across
// controlled variants (A/B/C/D). Run with: pnpm exec playwright test
// --config=playwright.ios-ime-freeze.config.ts e2e/ios-ime-freeze-measure.spec.ts

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3001";
const ADMIN_EMAIL = "ios-ime-freeze-e2e-admin@example.com";
const POST_SLUG_PREFIX = "ios-ime-freeze-e2e";
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
  });
}

async function seedFixtures() {
  originalSiteSettings = await snapshotSiteSettings();
  await cleanupFixtures();
  await upsertSetting("initialized", true);
  await upsertSetting("site_name", "iOS IME Freeze E2E");
  await upsertSetting("artist_name", "iOS IME Freeze Artist");
  await upsertSetting("artist_bio", "iOS IME freeze investigation fixtures.");
  const [admin] = await getDb()
    .insert(users)
    .values({ email: ADMIN_EMAIL, role: "admin", displayName: "iOS IME Freeze E2E" })
    .returning({ id: users.id });
  adminId = admin.id;
}

async function seedPost(bodyLength: "short" | "long") {
  postCounter += 1;
  const body = bodyLength === "long" ? "既存本文段落。".repeat(2000) : "既存本文段落。".repeat(5);
  const [post] = await getDb()
    .insert(posts)
    .values({
      title: `IOS IME Freeze Draft ${postCounter}`,
      slug: `${POST_SLUG_PREFIX}-${postCounter}`,
      summary: "ios ime freeze e2e summary.",
      body,
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
      userAgent: "ios-ime-freeze-e2e",
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

test.beforeAll(async () => {
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

const CHINESE_SAMPLE =
  "你好世界这是一个用于测试的中文段落希望能够触发安卓或苹果输入法组字事件序列并观察渲染性能表现如何随着字符数量增长而变化";

function sampleChars(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(CHINESE_SAMPLE[i % CHINESE_SAMPLE.length]);
  return out;
}

// Dispatches a realistic-ish IME composition sequence for each character:
// compositionstart -> compositionupdate -> beforeinput -> input -> compositionend
async function typeWithIme(page: Page, selector: string, chars: string[]) {
  return page.evaluate(
    ({ selector, chars }) => {
      const el = document.querySelector<HTMLTextAreaElement>(selector);
      if (!el) throw new Error("textarea not found");
      const timeline: { char: string; t0: number; t1: number }[] = [];
      let mutationCount = 0;
      const mo = new MutationObserver((records) => (mutationCount += records.length));
      mo.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      const longTasks: number[] = [];
      let po: PerformanceObserver | null = null;
      try {
        po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        po.observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
      } catch {
        // longtask not supported in this WebKit build
      }

      function fireComposition(type: string, data: string) {
        el!.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, cancelable: true }));
      }
      function fireInput(data: string) {
        try {
          el!.dispatchEvent(
            new InputEvent("beforeinput", {
              data,
              bubbles: true,
              cancelable: true,
              inputType: "insertCompositionText",
            }),
          );
        } catch {
          // ignore
        }
        el!.value = el!.value + data;
        el!.dispatchEvent(
          new InputEvent("input", { data, bubbles: true, inputType: "insertCompositionText" }),
        );
      }

      return new Promise<{
        timeline: typeof timeline;
        mutationCount: number;
        longTasks: number[];
        finalScrollHeight: number;
        finalClientHeight: number;
        finalValueLength: number;
        docScrollHeight: number;
        historyLength: number;
        historyStateApproxBytes: number;
      }>((resolve) => {
        let i = 0;
        function step() {
          if (i >= chars.length) {
            mo.disconnect();
            if (po) po.disconnect();
            let historyStateApproxBytes = 0;
            try {
              historyStateApproxBytes = JSON.stringify(window.history.state ?? null).length;
            } catch {
              historyStateApproxBytes = -1;
            }
            resolve({
              timeline,
              mutationCount,
              longTasks,
              finalScrollHeight: el!.scrollHeight,
              finalClientHeight: el!.clientHeight,
              finalValueLength: el!.value.length,
              docScrollHeight: document.documentElement.scrollHeight,
              historyLength: window.history.length,
              historyStateApproxBytes,
            });
            return;
          }
          const ch = chars[i];
          const t0 = performance.now();
          fireComposition("compositionstart", ch);
          fireComposition("compositionupdate", ch);
          fireInput(ch);
          fireComposition("compositionend", ch);
          requestAnimationFrame(() => {
            const t1 = performance.now();
            timeline.push({ char: ch, t0, t1 });
            i += 1;
            step();
          });
        }
        step();
      });
    },
    { selector, chars },
  );
}

function summarize(label: string, timeline: { t0: number; t1: number }[]) {
  const deltas = timeline.map((e) => e.t1 - e.t0).sort((a, b) => a - b);
  const p50 = deltas[Math.floor(deltas.length * 0.5)] ?? 0;
  const p95 = deltas[Math.floor(deltas.length * 0.95)] ?? 0;
  const second = timeline[1] ? timeline[1].t1 - timeline[1].t0 : NaN;
  const max = deltas[deltas.length - 1] ?? 0;
  return { label, n: timeline.length, p50, p95, max, secondCharDelay: second };
}

const CONDITIONS: { name: string; postKind: "new" | "existingShort" | "existingLong" }[] = [
  { name: "new-article", postKind: "new" },
  { name: "existing-short-body", postKind: "existingShort" },
  { name: "existing-long-body", postKind: "existingLong" },
];

for (const condition of CONDITIONS) {
  for (const n of [2, 10, 100]) {
    test(`measure: ${condition.name}, ${n} chars`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await installAdminSession(page);

      let url: string;
      if (condition.postKind === "new") {
        url = "/admin/posts/new";
      } else {
        const id = await seedPost(condition.postKind === "existingLong" ? "long" : "short");
        url = `/admin/posts/${id}`;
      }
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(String(err)));

      await page.goto(url);
      const textarea = page.getByRole("textbox", { name: "正文", exact: true });
      await expect(textarea).toBeVisible();

      const chars = sampleChars(n);
      const result = await typeWithIme(page, 'textarea[aria-label="正文"]', chars);
      const stats = summarize(`${condition.name}/${n}`, result.timeline);

      console.log(
        JSON.stringify({
          condition: condition.name,
          n,
          stats,
          mutationCount: result.mutationCount,
          longTaskCount: result.longTasks.length,
          longTaskTotalMs: result.longTasks.reduce((a, b) => a + b, 0),
          finalScrollHeight: result.finalScrollHeight,
          finalClientHeight: result.finalClientHeight,
          docScrollHeight: result.docScrollHeight,
          historyLength: result.historyLength,
          historyStateApproxBytes: result.historyStateApproxBytes,
          consoleErrorCount: consoleErrors.length,
          pageErrorCount: pageErrors.length,
          pageErrors,
        }),
      );

      expect(pageErrors, "no uncaught page errors during input").toEqual([]);
    });
  }
}

// LABELED APPROXIMATION, NOT A REAL REPRO of "background Safari, then
// foreground it" (real on-device Safari testing showed an immediate white
// screen on resume, Safari-only, not reproduced in other iOS WKWebView
// browsers). Linux WebKit has no WebContent-process suspension and no
// Safari tab-session snapshot/restore layer at all, so this can only fire
// the same page-lifecycle *events* a real cycle would (visibilitychange,
// pagehide, pageshow) and check the page doesn't error/blank out in
// response to those events + the dirty-guard's history entry being active.
// A clean pass here says nothing about whether Safari's real snapshot/
// restore layer is affected — it only rules out a page-lifecycle-event
// handler bug in this app's own JS, which is a much narrower claim.
test("approximate background/foreground cycle while dirty (Linux WebKit, not a real repro)", async ({
  page,
}) => {
  await installAdminSession(page);
  const id = await seedPost("long");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/posts/${id}`);
  const textarea = page.getByRole("textbox", { name: "正文", exact: true });
  await textarea.click();
  await textarea.type("你", { delay: 50 });
  await expect(textarea).toBeVisible();

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await page.waitForTimeout(200);

  await expect(textarea).toBeVisible();
  expect(pageErrors).toEqual([]);
});
