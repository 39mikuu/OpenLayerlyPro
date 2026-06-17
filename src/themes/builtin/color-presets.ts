import type { ThemeColorPreset } from "@/modules/theme/types";

/**
 * 内置主题的统一取色模板。管理员只能选择 hue，明暗模式下的 L/C 与变量集合由服务端固定，
 * 不接受任意 CSS 变量或值。
 */
export function colorVarsFromHue(hue: number) {
  return {
    light: {
      "--primary": `oklch(0.55 0.2 ${hue})`,
      "--primary-foreground": "oklch(0.985 0 0)",
      "--ring": `oklch(0.55 0.2 ${hue})`,
      "--accent": `oklch(0.95 0.03 ${hue})`,
      "--accent-foreground": `oklch(0.35 0.12 ${hue})`,
    },
    dark: {
      "--primary": `oklch(0.7 0.16 ${hue})`,
      "--primary-foreground": `oklch(0.18 0.04 ${hue})`,
      "--ring": `oklch(0.7 0.16 ${hue})`,
      "--accent": `oklch(0.32 0.07 ${hue})`,
      "--accent-foreground": `oklch(0.96 0.02 ${hue})`,
    },
  };
}

/**
 * 内置主题颜色预设。具名预设和自由取色共用上面的 L/C 模板；
 * `neutral` 的 hue=null，表示零覆盖；builtin 未配置时默认使用 blue。
 */
export const BUILTIN_COLOR_PRESETS: ThemeColorPreset[] = [
  { id: "neutral", name: "中性", hue: null },
  { id: "blue", name: "蓝", hue: 256 },
  { id: "green", name: "绿", hue: 150 },
  { id: "rose", name: "玫红", hue: 12 },
];

export const BUILTIN_DEFAULT_COLOR_PRESET_ID = "blue";
