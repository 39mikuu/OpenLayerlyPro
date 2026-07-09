import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSetting } from "@/modules/site";

vi.mock("server-only", () => ({}));

import {
  ACTIVE_THEME_SETTING_KEY,
  buildColorPresetCss,
  darkClassFromMode,
  DEFAULT_THEME_ID,
  getActiveTheme,
  getThemeConfig,
  resolveColorHue,
  resolveThemeId,
  themes,
} from "./registry";

// Mock 掉主题的 .tsx 组件树：本测只覆盖解析/回落/预设逻辑，组件本身由 tsc + build 保证。
vi.mock("@/themes/builtin", () => ({
  builtinTheme: {
    id: "builtin",
    name: "内置主题",
    components: {
      Chrome: () => null,
      Home: () => null,
      PostList: () => null,
      PostDetail: () => null,
    },
    colorPresets: [
      { id: "neutral", name: "中性", kind: "none" },
      { id: "blue", name: "蓝", kind: "hue", hue: 256 },
    ],
    defaultColorPresetId: "neutral",
    colorVarsFromHue: (hue: number) => ({
      light: { "--primary": `oklch(0.55 0.2 ${hue})` },
      dark: { "--primary": `oklch(0.7 0.16 ${hue})` },
    }),
  },
}));

vi.mock("@/themes/blog", () => ({
  blogTheme: {
    id: "blog",
    name: "博客主题",
    components: {
      Chrome: () => null,
      Home: () => null,
      PostList: () => null,
      PostDetail: () => null,
    },
    colorPresets: [
      { id: "ink", name: "墨", kind: "none" },
      { id: "indigo", name: "靛蓝", kind: "hue", hue: 275 },
    ],
    defaultColorPresetId: "ink",
    colorVarsFromHue: (hue: number) => ({
      light: { "--primary": `oklch(0.55 0.2 ${hue})` },
      dark: { "--primary": `oklch(0.7 0.16 ${hue})` },
    }),
  },
}));

vi.mock("@/themes/wordpress", () => ({
  wordpressTheme: {
    id: "wordpress",
    name: "WordPress 经典",
    components: {
      Chrome: () => null,
      Home: () => null,
      PostList: () => null,
      PostDetail: () => null,
    },
    colorPresets: [
      {
        id: "gofun-seiji",
        name: "胡粉 × 墨 × 青磁",
        kind: "vars",
        cssVars: {
          light: { "--primary": "oklch(0.52 0.09 195)", "--wordpress-seal": "oklch(0.53 0.17 18)" },
          dark: { "--primary": "oklch(0.72 0.10 190)", "--wordpress-seal": "oklch(0.70 0.15 18)" },
        },
      },
      {
        id: "layer-seal",
        name: "層印品牌",
        kind: "vars",
        cssVars: {
          light: { "--primary": "oklch(0.52 0.09 195)", "--wordpress-seal": "oklch(0.53 0.17 18)" },
          dark: { "--primary": "oklch(0.72 0.10 190)", "--wordpress-seal": "oklch(0.70 0.15 18)" },
        },
      },
    ],
    defaultColorPresetId: "gofun-seiji",
  },
}));

vi.mock("@/modules/site", () => ({ getSetting: vi.fn() }));

const mockedGetSetting = vi.mocked(getSetting);

describe("theme registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSetting.mockResolvedValue(null);
  });

  it("resolves known / unknown / empty theme ids to a valid id", () => {
    expect(resolveThemeId("builtin")).toBe("builtin");
    expect(resolveThemeId("blog")).toBe("blog");
    expect(resolveThemeId("wordpress")).toBe("wordpress");
    expect(resolveThemeId(null)).toBe("builtin");
    expect(resolveThemeId("nope")).toBe("builtin");
    expect(resolveThemeId("toString")).toBe("builtin");
    expect(resolveThemeId("constructor")).toBe("builtin");
    expect(resolveThemeId("__proto__")).toBe("builtin");
    expect(DEFAULT_THEME_ID).toBe("builtin");
  });

  it("getActiveTheme falls back to builtin", async () => {
    mockedGetSetting.mockResolvedValue(null);
    expect((await getActiveTheme()).id).toBe("builtin");
    expect(mockedGetSetting).toHaveBeenCalledWith(ACTIVE_THEME_SETTING_KEY);
  });

  it("darkClassFromMode only treats explicit dark as dark", () => {
    expect(darkClassFromMode("dark")).toBe("dark");
    expect(darkClassFromMode("light")).toBe("");
    expect(darkClassFromMode("system")).toBe("");
    expect(darkClassFromMode(undefined)).toBe("");
    expect(darkClassFromMode("anything")).toBe("");
  });

  it("resolveColorHue handles custom, hue, none, vars and unknown presets", () => {
    expect(resolveColorHue(themes.builtin, { colorPreset: "custom", customHue: 42 })).toBe(42);
    expect(resolveColorHue(themes.builtin, { colorPreset: "blue" })).toBe(256);
    expect(resolveColorHue(themes.builtin, { colorPreset: "neutral" })).toBeNull();
    expect(resolveColorHue(themes.wordpress, { colorPreset: "gofun-seiji" })).toBeNull();
    expect(resolveColorHue(themes.builtin, { colorPreset: "does-not-exist" })).toBeNull();
  });

  it("buildColorPresetCss returns null for none, unknown presets, and unsupported custom", () => {
    expect(buildColorPresetCss(themes.builtin, { colorPreset: "neutral" })).toBeNull();
    expect(buildColorPresetCss(themes.builtin, { colorPreset: "does-not-exist" })).toBeNull();
    expect(
      buildColorPresetCss(themes.wordpress, { colorPreset: "custom", customHue: 42 }),
    ).toBeNull();
  });

  it("buildColorPresetCss scopes custom hue overrides to .site-theme only", () => {
    const css = buildColorPresetCss(themes.builtin, {
      colorPreset: "custom",
      customHue: 42,
    });
    expect(css).not.toBeNull();
    expect(css).toContain(".site-theme{");
    expect(css).toContain(".dark .site-theme{");
    expect(css).toContain("--primary: oklch(0.55 0.2 42);");
    expect(css).not.toMatch(/NaN|undefined|null|:root|html/);
  });

  it("buildColorPresetCss emits exact vars presets without exposing root selectors", () => {
    const css = buildColorPresetCss(themes.wordpress, { colorPreset: "layer-seal" });
    expect(css).not.toBeNull();
    expect(css).toContain(".site-theme{");
    expect(css).toContain(".dark .site-theme{");
    expect(css).toContain("--wordpress-seal: oklch(0.53 0.17 18);");
    expect(css).toContain("--wordpress-seal: oklch(0.70 0.15 18);");
    expect(css).not.toMatch(/NaN|undefined|null|:root|html/);
  });

  it("getThemeConfig falls back to default preset for missing/invalid stored values", async () => {
    mockedGetSetting.mockResolvedValue(null);
    expect(await getThemeConfig(themes.builtin)).toEqual({
      colorPreset: "neutral",
      customHue: 256,
    });
    expect(await getThemeConfig(themes.wordpress)).toEqual({
      colorPreset: "gofun-seiji",
      customHue: 0,
    });

    mockedGetSetting.mockResolvedValue({ colorPreset: "ghost", customHue: 721.6 });
    expect(await getThemeConfig(themes.builtin)).toEqual({
      colorPreset: "neutral",
      customHue: 2,
    });
  });

  it("getThemeConfig returns valid presets and normalizes custom hue", async () => {
    mockedGetSetting.mockResolvedValue({ colorPreset: "blue", customHue: 150 });
    expect(await getThemeConfig(themes.builtin)).toEqual({
      colorPreset: "blue",
      customHue: 150,
    });

    mockedGetSetting.mockResolvedValue({ colorPreset: "custom", customHue: -1.6 });
    expect(await getThemeConfig(themes.builtin)).toEqual({
      colorPreset: "custom",
      customHue: 358,
    });

    mockedGetSetting.mockResolvedValue({ colorPreset: "custom" });
    expect(await getThemeConfig(themes.builtin)).toEqual({
      colorPreset: "custom",
      customHue: 256,
    });
  });

  it("reads per-theme keyed config and scopes legacy flat config to builtin only", async () => {
    // 新形态：按主题分键，各读各的。
    mockedGetSetting.mockResolvedValue({
      builtin: { colorPreset: "blue" },
      blog: { colorPreset: "indigo" },
      wordpress: { colorPreset: "layer-seal", customHue: 123 },
    });
    expect((await getThemeConfig(themes.builtin)).colorPreset).toBe("blue");
    expect((await getThemeConfig(themes.blog)).colorPreset).toBe("indigo");
    expect(await getThemeConfig(themes.wordpress)).toEqual({
      colorPreset: "layer-seal",
      customHue: 123,
    });

    // 旧平铺形态只可能由单主题时期写入：归 builtin，其他主题回落自身默认。
    mockedGetSetting.mockResolvedValue({ colorPreset: "blue", customHue: 100 });
    expect((await getThemeConfig(themes.builtin)).colorPreset).toBe("blue");
    expect((await getThemeConfig(themes.blog)).colorPreset).toBe("ink");
    expect((await getThemeConfig(themes.wordpress)).colorPreset).toBe("gofun-seiji");
  });
});
