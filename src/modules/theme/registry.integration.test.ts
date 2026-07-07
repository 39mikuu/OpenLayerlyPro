import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getDb } from "@/db";
import { auditEvents, siteSettings } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import {
  ACTIVE_THEME_SETTING_KEY,
  applyThemeUpdate,
  THEME_CONFIG_SETTING_KEY,
  themes,
} from "@/modules/theme";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const actor = { type: "admin" as const, id: "00000000-0000-4000-8000-000000000001" };

describeWithDatabase("theme registry transactional updates", () => {
  const db = getDb();
  const raw = postgres(getEnv().DATABASE_URL, { max: 6, onnotice: () => {} });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await resetDatabase(db);
    await raw.end({ timeout: 5 });
  });

  async function waitForQueryLock(queryPattern: string): Promise<{ pid: number; query: string }> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [activity] = await raw<
        {
          pid: number;
          query: string;
        }[]
      >`
        select pid::integer, query
          from pg_stat_activity
         where wait_event_type = 'Lock'
           and query ilike ${queryPattern}
         order by query_start desc
         limit 1
      `;
      if (activity) return activity;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no backend entered a PostgreSQL lock wait for ${queryPattern}`);
  }

  async function settingValue(key: string): Promise<unknown> {
    const [row] = await db
      .select({ valueJson: siteSettings.valueJson })
      .from(siteSettings)
      .where(eq(siteSettings.key, key));
    return row?.valueJson;
  }

  // waitForQueryLock alone budgets up to 5s; vitest's 5s default test timeout would
  // otherwise race it and abandon the test mid-poll, orphaning c1's uncommitted
  // lock-holding transaction on a pooled connection and hanging every later hook
  // that needs to touch site_settings.
  const LOCK_TEST_TIMEOUT_MS = 15_000;

  it(
    "locks the theme_config row with SELECT FOR UPDATE",
    async () => {
      await db.insert(siteSettings).values({
        key: THEME_CONFIG_SETTING_KEY,
        valueJson: { builtin: { colorPreset: "neutral", customHue: 256 } },
      });

      const c1 = await raw.reserve();
      const c2 = await raw.reserve();
      try {
        await c1`begin`;
        await c2`begin`;
        await c1`select id from site_settings where key = ${THEME_CONFIG_SETTING_KEY} for update`;

        // postgres.js queries are dispatched lazily on `.then()`/`.execute()`, not on
        // construction — without this, `blocked` never actually reaches the server
        // until the `expect(blocked)` below, by which point c1 has already committed
        // and there is nothing left to block on.
        const blocked =
          c2`select id from site_settings where key = ${THEME_CONFIG_SETTING_KEY} for update`.execute();
        await waitForQueryLock("%site_settings%for update%");

        await c1`commit`;
        await expect(blocked).resolves.toHaveLength(1);
        await c2`commit`;
      } finally {
        await c1.release();
        await c2.release();
      }
    },
    LOCK_TEST_TIMEOUT_MS,
  );

  it("preserves both themes' config when different themes update concurrently", async () => {
    await db.insert(siteSettings).values({
      key: THEME_CONFIG_SETTING_KEY,
      valueJson: {
        builtin: { colorPreset: "neutral", customHue: 256 },
        blog: { colorPreset: "ink", customHue: 275 },
      },
    });

    await Promise.all([
      applyThemeUpdate(
        themes.builtin,
        { colorPreset: "custom", customHue: 42 },
        { switchActiveTheme: false, actor },
      ),
      applyThemeUpdate(
        themes.blog,
        { colorPreset: "indigo", customHue: 314 },
        { switchActiveTheme: false, actor },
      ),
    ]);

    expect(await settingValue(THEME_CONFIG_SETTING_KEY)).toEqual({
      builtin: { colorPreset: "custom", customHue: 42 },
      blog: { colorPreset: "indigo", customHue: 314 },
    });
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "theme_updated"));
    expect(audits).toHaveLength(2);
    expect(audits.map((event) => event.entityType)).toEqual([
      "site_theme_config",
      "site_theme_config",
    ]);
  });

  it("updates config, switches active theme, and records audit atomically", async () => {
    const result = await applyThemeUpdate(
      themes.blog,
      { colorPreset: "custom", customHue: 123 },
      { switchActiveTheme: true, actor },
    );

    expect(result).toEqual({ colorPreset: "custom", customHue: 123 });
    const [themeConfig] = await db
      .select({ id: siteSettings.id, valueJson: siteSettings.valueJson })
      .from(siteSettings)
      .where(eq(siteSettings.key, THEME_CONFIG_SETTING_KEY));
    expect(themeConfig?.valueJson).toEqual({ blog: { colorPreset: "custom", customHue: 123 } });
    expect(await settingValue(ACTIVE_THEME_SETTING_KEY)).toBe("blog");

    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "theme_updated"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "site_theme_config",
      entityId: themeConfig?.id,
      actorType: "admin",
      actorId: actor.id,
    });
    expect(audits[0]!.beforeJson).toEqual({ themeId: "blog" });
    expect(audits[0]!.afterJson).toEqual({
      themeId: "blog",
      colorPreset: "custom",
      customHue: 123,
      activeThemeSwitched: true,
    });
  });
});
