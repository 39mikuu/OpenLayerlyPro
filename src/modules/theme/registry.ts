import "server-only";

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { cache } from "react";

import { getDb } from "@/db";
import { siteSettings } from "@/db/schema";
import { type AuditActor, recordAudit } from "@/modules/audit";
import { getSetting } from "@/modules/site";
import { blogTheme } from "@/themes/blog";
import { builtinTheme } from "@/themes/builtin";

import type { Theme, ThemeConfig, ThemeId } from "./types";

export const DEFAULT_THEME_ID: ThemeId = "builtin";

/** 站内已注册主题（编译期静态注册表；主题均为一等公民代码，无运行时加载面）。 */
export const themes: Record<ThemeId, Theme> = {
  builtin: builtinTheme,
  blog: blogTheme,
};

/** site_settings 中存放活动主题 id 的键。 */
export const ACTIVE_THEME_SETTING_KEY = "theme";
/** site_settings 中存放站点级主题配置（颜色预设等）的键。 */
export const THEME_CONFIG_SETTING_KEY = "theme_config";
/** 访客明暗偏好 cookie（仅访客偏好，不入 site_settings）。 */
export const THEME_MODE_COOKIE = "theme_mode";

function defaultCustomHue(theme: Theme): number {
  return theme.colorPresets.find((preset) => preset.hue !== null)?.hue ?? 0;
}

export function normalizeHue(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return ((rounded % 360) + 360) % 360;
}

/** 把存储值解析为已知主题 id；未知或缺省回落内置主题。 */
export function resolveThemeId(stored: string | null | undefined): ThemeId {
  return stored && Object.hasOwn(themes, stored) ? (stored as ThemeId) : DEFAULT_THEME_ID;
}

/**
 * 解析当前活动主题：读 site_settings.theme，未知/缺省回落内置主题。
 * 这是 Core 配置驱动主题切换的接缝（本步仅内置主题，切换 UI 留后续）。
 */
export const getActiveTheme = cache(async (): Promise<Theme> => {
  const stored = await getSetting<string>(ACTIVE_THEME_SETTING_KEY);
  return themes[resolveThemeId(stored)];
});

/** 由明暗偏好 cookie 解析出 SSR 时 `<html>` 的 class（仅显式 dark；system/light 交给内联脚本）。 */
export function darkClassFromMode(mode: string | null | undefined): "dark" | "" {
  return mode === "dark" ? "dark" : "";
}

type StoredThemeEntry = { colorPreset?: string; customHue?: number };

/**
 * 从存储值中取出指定主题的配置条目。
 * 新形态按主题 id 分键：`{ builtin: {...}, blog: {...} }`；
 * 旧平铺形态 `{ colorPreset, customHue }` 只可能由单主题时期写入，归属默认主题。
 */
function extractThemeEntry(stored: unknown, themeId: ThemeId): StoredThemeEntry | null {
  if (!stored || typeof stored !== "object") return null;
  const record = stored as Record<string, unknown>;
  const nested = record[themeId];
  if (nested && typeof nested === "object") return nested as StoredThemeEntry;
  if (themeId === DEFAULT_THEME_ID && typeof record.colorPreset === "string") {
    return record as StoredThemeEntry;
  }
  return null;
}

/**
 * 读取站点级主题配置（按主题分键，兼容旧平铺形态）：非法预设回落默认，
 * hue 取整并归一化到 [0, 360)。customHue 对具名预设不生效，但保留它可避免
 * 管理员切换预设后丢失自定义选择。
 */
export const getThemeConfig = cache(async (theme: Theme): Promise<ThemeConfig> => {
  const stored = extractThemeEntry(await getSetting<unknown>(THEME_CONFIG_SETTING_KEY), theme.id);
  const id = stored?.colorPreset;
  const valid =
    id === "custom"
      ? typeof theme.colorVarsFromHue === "function"
      : Boolean(id && theme.colorPresets.some((preset) => preset.id === id));
  return {
    colorPreset: valid ? (id as string) : theme.defaultColorPresetId,
    customHue: normalizeHue(stored?.customHue, defaultCustomHue(theme)),
  };
});

function mergeThemeConfigEntries(
  stored: unknown,
  theme: Theme,
  config: ThemeConfig,
): Partial<Record<ThemeId, StoredThemeEntry>> {
  const next: Partial<Record<ThemeId, StoredThemeEntry>> = {};
  for (const id of Object.keys(themes) as ThemeId[]) {
    const entry = extractThemeEntry(stored, id);
    if (entry) next[id] = { colorPreset: entry.colorPreset, customHue: entry.customHue };
  }
  next[theme.id] = config;
  return next;
}

/**
 * 原子应用管理员主题更新：锁定 theme_config 行、合并单主题配置、可选切换活动主题，
 * 并在同一事务内记录审计事件，避免跨主题颜色配置并发写入互相覆盖。
 */
export async function applyThemeUpdate(
  theme: Theme,
  patch: { colorPreset: string; customHue?: number },
  options: { switchActiveTheme: boolean; actor: AuditActor },
): Promise<ThemeConfig> {
  return getDb().transaction(async (tx) => {
    await tx
      .insert(siteSettings)
      .values({ key: THEME_CONFIG_SETTING_KEY, valueJson: {} })
      .onConflictDoNothing({ target: siteSettings.key });

    const [row] = await tx
      .select({ id: siteSettings.id, valueJson: siteSettings.valueJson })
      .from(siteSettings)
      .where(eq(siteSettings.key, THEME_CONFIG_SETTING_KEY))
      .limit(1)
      .for("update");
    if (!row) throw new Error("Failed to lock theme_config setting");

    const currentEntry = extractThemeEntry(row.valueJson, theme.id);
    const nextEntry: ThemeConfig = {
      colorPreset: patch.colorPreset,
      customHue: normalizeHue(patch.customHue ?? currentEntry?.customHue, defaultCustomHue(theme)),
    };
    const next = mergeThemeConfigEntries(row.valueJson, theme, nextEntry);

    await tx
      .insert(siteSettings)
      .values({ key: THEME_CONFIG_SETTING_KEY, valueJson: next })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { valueJson: next, updatedAt: new Date() },
      });

    if (options.switchActiveTheme) {
      await tx
        .insert(siteSettings)
        .values({ key: ACTIVE_THEME_SETTING_KEY, valueJson: theme.id })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { valueJson: theme.id, updatedAt: new Date() },
        });
    }

    await recordAudit(tx, {
      entityType: "site_theme_config",
      entityId: row.id,
      action: "theme_updated",
      actor: options.actor,
      before: { themeId: theme.id, ...(currentEntry ?? {}) },
      after: {
        themeId: theme.id,
        ...nextEntry,
        activeThemeSwitched: options.switchActiveTheme,
      },
      correlationId: randomUUID(),
    });

    return nextEntry;
  });
}

/** 把具名预设或 custom 配置解析为最终 hue；neutral / 未知配置不生成覆盖。 */
export function resolveColorHue(theme: Theme, config: ThemeConfig): number | null {
  if (config.colorPreset === "custom") {
    if (typeof theme.colorVarsFromHue !== "function") return null;
    return normalizeHue(config.customHue, defaultCustomHue(theme));
  }
  return theme.colorPresets.find((preset) => preset.id === config.colorPreset)?.hue ?? null;
}

function declarations(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join("");
}

/**
 * 由主题取色模板生成**作用域限定**的 CSS（`.site-theme` / `.dark .site-theme`）。
 * 只影响公开站点、不影响 admin；neutral、未知预设或不支持自由取色的主题返回 null。
 */
export function buildColorPresetCss(theme: Theme, config: ThemeConfig): string | null {
  const hue = resolveColorHue(theme, config);
  if (hue === null || typeof theme.colorVarsFromHue !== "function") return null;
  const { light, dark } = theme.colorVarsFromHue(hue);
  const lightKeys = Object.keys(light);
  const darkKeys = Object.keys(dark);
  if (lightKeys.length === 0 && darkKeys.length === 0) return null;
  let css = "";
  if (lightKeys.length > 0) css += `.site-theme{${declarations(light)}}`;
  if (darkKeys.length > 0) css += `.dark .site-theme{${declarations(dark)}}`;
  return css || null;
}

/**
 * 注入 `<head>` 前运行的极小阻塞脚本：**只**读 theme_mode cookie + 系统偏好，
 * 在首屏绘制前为 `<html>` 设置 `.dark`，消除闪烁。绝不内联/回显任何站点配置。
 */
export const THEME_INIT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)theme_mode=([^;]+)/);var v=m?decodeURIComponent(m[1]):"";var d=v==="dark"||(v!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;
