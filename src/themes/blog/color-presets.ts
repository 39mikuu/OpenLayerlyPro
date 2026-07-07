import type { ThemeColorPreset } from "@/modules/theme/types";

export { colorVarsFromHue } from "@/themes/builtin/color-presets";

/**
 * 博客主题颜色预设。取色模板与内置主题共用（同一 L/C 约束，只接收 hue）；
 * `ink` 的 hue=null 表示零覆盖，作为博客主题的默认阅读配色。
 */
export const BLOG_COLOR_PRESETS: ThemeColorPreset[] = [
  { id: "ink", name: "墨", hue: null },
  { id: "indigo", name: "靛蓝", hue: 275 },
  { id: "teal", name: "青", hue: 190 },
  { id: "amber", name: "琥珀", hue: 70 },
];

export const BLOG_DEFAULT_COLOR_PRESET_ID = "ink";
