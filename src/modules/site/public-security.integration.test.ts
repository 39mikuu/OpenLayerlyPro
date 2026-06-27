import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { siteSettings } from "@/db/schema";

import {
  CUSTOM_FOOTER_MARKUP_KEY,
  LEGACY_CUSTOM_FOOTER_KEY,
  parsePublicSecuritySettings,
  PUBLIC_CSP_REVISION_KEY,
  PUBLIC_SECURITY_SETTING_KEYS,
  updatePublicSecuritySettings,
} from "./public-security";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("public security settings integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await db
      .delete(siteSettings)
      .where(inArray(siteSettings.key, [...PUBLIC_SECURITY_SETTING_KEYS, "site_name"]));
  });

  async function insertSetting(key: string, valueJson: unknown): Promise<void> {
    await db.insert(siteSettings).values({ key, valueJson });
  }

  async function readSetting(key: string): Promise<unknown> {
    const [row] = await db
      .select({ valueJson: siteSettings.valueJson })
      .from(siteSettings)
      .where(eq(siteSettings.key, key))
      .limit(1);
    return row?.valueJson;
  }

  it("atomically migrates safe legacy markup and advances the CSP revision", async () => {
    const legacyMarkup = '<p class="filing"><a href="https://example.com">ICP</a></p>';
    await insertSetting(LEGACY_CUSTOM_FOOTER_KEY, legacyMarkup);

    await updatePublicSecuritySettings({ legacyAction: "migrate-safe" });

    expect(await readSetting(CUSTOM_FOOTER_MARKUP_KEY)).toBe(legacyMarkup);
    expect(await readSetting(LEGACY_CUSTOM_FOOTER_KEY)).toBeUndefined();
    expect(await readSetting(PUBLIC_CSP_REVISION_KEY)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("rejects executable legacy content without partially updating settings", async () => {
    await insertSetting(LEGACY_CUSTOM_FOOTER_KEY, "<script>window.legacy=true</script>");

    await expect(
      updatePublicSecuritySettings({
        customFooterMarkup: "<p>replacement</p>",
        legacyAction: "migrate-safe",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "legacyFooterRequiresManualMigration",
    });

    expect(await readSetting(CUSTOM_FOOTER_MARKUP_KEY)).toBeUndefined();
    expect(await readSetting(LEGACY_CUSTOM_FOOTER_KEY)).toBe("<script>window.legacy=true</script>");
    expect(await readSetting(PUBLIC_CSP_REVISION_KEY)).toBeUndefined();
  });

  it("refuses to overwrite different safe footer content during one-click migration", async () => {
    await insertSetting(LEGACY_CUSTOM_FOOTER_KEY, "<p>Legacy filing</p>");
    await insertSetting(CUSTOM_FOOTER_MARKUP_KEY, "<p>Current filing</p>");

    await expect(
      updatePublicSecuritySettings({ legacyAction: "migrate-safe" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "legacyFooterMigrationTargetNotEmpty",
    });

    expect(await readSetting(CUSTOM_FOOTER_MARKUP_KEY)).toBe("<p>Current filing</p>");
    expect(await readSetting(LEGACY_CUSTOM_FOOTER_KEY)).toBe("<p>Legacy filing</p>");
    expect(await readSetting(PUBLIC_CSP_REVISION_KEY)).toBeUndefined();
  });

  it("serializes migration against a concurrent safe-footer save", async () => {
    await insertSetting(LEGACY_CUSTOM_FOOTER_KEY, "<p>Legacy filing</p>");
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrentSave = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('openlayerlypro:public-security-settings', 0))`,
      );
      locked();
      await releaseLock;
      await tx.insert(siteSettings).values({
        key: CUSTOM_FOOTER_MARKUP_KEY,
        valueJson: "<p>Concurrent filing</p>",
      });
    });

    await lockAcquired;
    const migration = updatePublicSecuritySettings({ legacyAction: "migrate-safe" });
    release();
    await concurrentSave;

    await expect(migration).rejects.toMatchObject({
      status: 409,
      code: "legacyFooterMigrationTargetNotEmpty",
    });
    expect(await readSetting(CUSTOM_FOOTER_MARKUP_KEY)).toBe("<p>Concurrent filing</p>");
    expect(await readSetting(LEGACY_CUSTOM_FOOTER_KEY)).toBe("<p>Legacy filing</p>");
  });

  it("clears executable legacy content explicitly and advances the revision", async () => {
    await insertSetting(LEGACY_CUSTOM_FOOTER_KEY, "<script>window.legacy=true</script>");

    await updatePublicSecuritySettings({ legacyAction: "clear" });

    expect(await readSetting(LEGACY_CUSTOM_FOOTER_KEY)).toBeUndefined();
    expect(await readSetting(PUBLIC_CSP_REVISION_KEY)).toEqual(expect.any(String));
  });

  it("applies auto, report-only, and enforce to persisted executable legacy state", async () => {
    await insertSetting(CUSTOM_FOOTER_MARKUP_KEY, "<p>Safe filing</p>");
    await insertSetting(LEGACY_CUSTOM_FOOTER_KEY, "<script>window.persistedLegacy=true</script>");
    const persisted = {
      [CUSTOM_FOOTER_MARKUP_KEY]: await readSetting(CUSTOM_FOOTER_MARKUP_KEY),
      [LEGACY_CUSTOM_FOOTER_KEY]: await readSetting(LEGACY_CUSTOM_FOOTER_KEY),
    };

    for (const mode of ["auto", "report-only"] as const) {
      const state = parsePublicSecuritySettings(persisted, mode);
      expect(state.effectiveMode).toBe("report-only");
      expect(state.footerHtml).toContain("<script>window.persistedLegacy=true</script>");
    }

    const enforced = parsePublicSecuritySettings(persisted, "enforce");
    expect(enforced.effectiveMode).toBe("enforce");
    expect(enforced.footerHtml).toBe("<p>Safe filing</p>");
    expect(enforced.legacyFooterHtml).toBe("<script>window.persistedLegacy=true</script>");
  });

  it("sanitizes markup and changes the revision on every accepted update", async () => {
    await updatePublicSecuritySettings({
      customFooterMarkup: '<p onclick="run()">safe text</p><script>run()</script>',
    });
    const firstRevision = await readSetting(PUBLIC_CSP_REVISION_KEY);

    await updatePublicSecuritySettings({ customFooterMarkup: "<p>second value</p>" });

    expect(await readSetting(CUSTOM_FOOTER_MARKUP_KEY)).toBe("<p>second value</p>");
    expect(await readSetting(PUBLIC_CSP_REVISION_KEY)).not.toBe(firstRevision);
  });

  it("rejects a stale revision before applying public or ordinary site settings", async () => {
    await insertSetting(PUBLIC_CSP_REVISION_KEY, "current-revision");
    await insertSetting(CUSTOM_FOOTER_MARKUP_KEY, "<p>Current filing</p>");
    await insertSetting("site_name", "Current name");

    await expect(
      updatePublicSecuritySettings({
        expectedRevision: "stale-revision",
        customFooterMarkup: "<p>Stale filing</p>",
        additionalSettings: { site_name: "Stale name" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "publicSecurityRevisionConflict",
    });

    expect(await readSetting(CUSTOM_FOOTER_MARKUP_KEY)).toBe("<p>Current filing</p>");
    expect(await readSetting("site_name")).toBe("Current name");
    expect(await readSetting(PUBLIC_CSP_REVISION_KEY)).toBe("current-revision");
  });

  it("allows only one concurrent writer for the same expected revision", async () => {
    await insertSetting(PUBLIC_CSP_REVISION_KEY, "shared-revision");

    const results = await Promise.allSettled([
      updatePublicSecuritySettings({
        expectedRevision: "shared-revision",
        customFooterMarkup: "<p>First writer</p>",
      }),
      updatePublicSecuritySettings({
        expectedRevision: "shared-revision",
        customFooterMarkup: "<p>Second writer</p>",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      code: "publicSecurityRevisionConflict",
    });
    expect(["<p>First writer</p>", "<p>Second writer</p>"]).toContain(
      await readSetting(CUSTOM_FOOTER_MARKUP_KEY),
    );
    expect(await readSetting(PUBLIC_CSP_REVISION_KEY)).not.toBe("shared-revision");
  });
});
