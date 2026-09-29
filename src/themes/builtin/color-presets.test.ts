import { describe, expect, it } from "vitest";

import { BLOG_COLOR_PRESETS } from "@/themes/blog/color-presets";
import { WORDPRESS_COLOR_PRESETS } from "@/themes/wordpress/color-presets";

import { contrastRatio, huePrimaryContrast, oklchLuminance } from "./color-contrast";
import {
  BUILTIN_COLOR_PRESETS,
  BUILTIN_DEFAULT_COLOR_PRESET_ID,
  colorVarsFromHue,
} from "./color-presets";

const defaults = {
  light: {
    "--background": "oklch(1 0 0)",
    "--card": "oklch(1 0 0)",
    "--primary": "oklch(0.205 0 0)",
    "--primary-foreground": "oklch(0.985 0 0)",
  },
  dark: {
    "--background": "oklch(0.145 0 0)",
    "--card": "oklch(0.205 0 0)",
    "--primary": "oklch(0.922 0 0)",
    "--primary-foreground": "oklch(0.205 0 0)",
  },
};

function luminance(value: string): number {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!match) throw new Error(`Unexpected color token: ${value}`);
  return oklchLuminance(Number(match[1]), Number(match[2]), Number(match[3]));
}

function assertPrimaryContrast(vars: Record<string, string>, mode: "light" | "dark") {
  const tokens = { ...defaults[mode], ...vars };
  const primary = luminance(tokens["--primary"]);
  expect(contrastRatio(primary, luminance(tokens["--primary-foreground"]))).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(contrastRatio(primary, luminance(tokens["--background"]))).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(primary, luminance(tokens["--card"]))).toBeGreaterThanOrEqual(4.5);
}

describe("public theme primary contrast", () => {
  it("uses the FANBOX-like blue preset by default", () => {
    expect(BUILTIN_DEFAULT_COLOR_PRESET_ID).toBe("blue");
    expect(
      BUILTIN_COLOR_PRESETS.find((preset) => preset.id === BUILTIN_DEFAULT_COLOR_PRESET_ID),
    ).toMatchObject({ hue: 256 });
    expect(colorVarsFromHue(256).light["--primary"]).toContain("256");
  });

  it("meets AA for every named preset in both modes", () => {
    for (const preset of [
      ...BUILTIN_COLOR_PRESETS,
      ...BLOG_COLOR_PRESETS,
      ...WORDPRESS_COLOR_PRESETS,
    ]) {
      const vars =
        preset.kind === "hue"
          ? colorVarsFromHue(preset.hue)
          : preset.kind === "vars"
            ? preset.cssVars
            : { light: {}, dark: {} };
      assertPrimaryContrast(vars.light, "light");
      assertPrimaryContrast(vars.dark, "dark");
    }
  });

  it("meets AA for the full selectable hue range, including both boundaries", () => {
    for (let hue = 0; hue <= 359; hue += 1) {
      const vars = colorVarsFromHue(hue);
      assertPrimaryContrast(vars.light, "light");
      assertPrimaryContrast(vars.dark, "dark");
      const feedback = huePrimaryContrast(hue);
      expect(feedback.light).toBeGreaterThanOrEqual(4.5);
      expect(feedback.dark).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("rejects invalid custom hue inputs before save", () => {
    expect(huePrimaryContrast(-1)).toEqual({ light: 0, dark: 0 });
    expect(huePrimaryContrast(360)).toEqual({ light: 0, dark: 0 });
    expect(huePrimaryContrast(Number.NaN)).toEqual({ light: 0, dark: 0 });
  });
});
