import "server-only";

import { cache } from "react";

import { getSetting, setSetting } from "@/modules/site";
import { builtinTheme } from "@/themes/builtin";

import type { Theme, ThemeConfig, ThemeId } from "./types";

export const DEFAULT_THEME_ID: ThemeId = "builtin";

/** 站内已注册主题（本步仅内置主题）。 */
export const themes: Record<ThemeId, Theme> = {
  builtin: builtinTheme,
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

function normalizeHue(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return ((rounded % 360) + 360) % 360;
}

/** 把存储值解析为已知主题 id；未知或缺省回落内置主题。 */
export function resolveThemeId(stored: string | null | undefined): ThemeId {
  return stored && stored in themes ? (stored as ThemeId) : DEFAULT_THEME_ID;
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

/**
 * 读取站点级主题配置：非法预设回落默认，hue 取整并归一化到 [0, 360)。
 * customHue 对具名预设不生效，但保留它可避免管理员切换预设后丢失自定义选择。
 */
export const getThemeConfig = cache(async (theme: Theme): Promise<ThemeConfig> => {
  const stored = await getSetting<{ colorPreset?: string; customHue?: number }>(
    THEME_CONFIG_SETTING_KEY,
  );
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

/** 写入站点级主题配置（管理员）。 */
export async function setThemeConfig(config: ThemeConfig): Promise<void> {
  await setSetting(THEME_CONFIG_SETTING_KEY, config);
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
