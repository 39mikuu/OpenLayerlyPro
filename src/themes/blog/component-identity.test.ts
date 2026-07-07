import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildColorPresetCss, normalizeHue, resolveColorHue } from "@/modules/theme/registry";
import type { Theme } from "@/modules/theme/types";
import { blogTheme } from "@/themes/blog";
import { builtinTheme } from "@/themes/builtin";

const reusedBodySlots = ["PostDetail", "Tiers", "Login", "Me", "MeOrders", "Checkout"] as const;
const overriddenSlots = ["Chrome", "Home", "PostList"] as const;

function expectSyntacticThemeCss(css: string, hue: number) {
  expect(css).toContain(".site-theme{");
  expect(css).toContain(".dark .site-theme{");
  expect(css).toMatch(/--[a-z-]+: [^;{}]+;/);
  expect(css).toContain(` ${hue})`);
  expect(css).not.toMatch(/NaN|undefined|null/);
}

describe("blog theme component identity", () => {
  it("reuses builtin body components that have no theme-specific body implementation risk", () => {
    // This proves only the six body-component slots are shared by reference.
    // Public pages are still wrapped in the active theme Chrome, which Blog overrides.
    for (const slot of reusedBodySlots) {
      expect(blogTheme.components[slot]).toBeDefined();
      expect(builtinTheme.components[slot]).toBeDefined();
      expect(blogTheme.components[slot]).toBe(builtinTheme.components[slot]);
    }
  });

  it("overrides chrome, home and post list components", () => {
    for (const slot of overriddenSlots) {
      expect(blogTheme.components[slot]).toBeDefined();
      expect(builtinTheme.components[slot]).toBeDefined();
      expect(blogTheme.components[slot]).not.toBe(builtinTheme.components[slot]);
    }
  });
});

describe("real theme color preset and hue behavior", () => {
  const themeCases: ReadonlyArray<[string, Theme]> = [
    ["builtin", builtinTheme],
    ["blog", blogTheme],
  ];

  it.each(themeCases)("resolves every %s named preset", (_themeName, theme) => {
    for (const preset of theme.colorPresets) {
      const config = { colorPreset: preset.id };
      expect(resolveColorHue(theme, config)).toBe(preset.hue);
      const css = buildColorPresetCss(theme, config);

      if (preset.hue === null) {
        expect(css).toBeNull();
      } else {
        expect(css).not.toBeNull();
        expectSyntacticThemeCss(css!, preset.hue);
      }
    }
  });

  it.each([
    [0, 0],
    [359, 359],
    [360, 0],
    [-1, 359],
    [-1.6, 358],
    [721.6, 2],
    [Number.NaN, 123],
    ["42", 123],
  ] as const)("normalizes hue %s to %s", (input, expected) => {
    expect(normalizeHue(input, 123)).toBe(expected);
  });

  it.each(themeCases)(
    "normalizes custom hue and emits valid scoped CSS for %s",
    (_themeName, theme) => {
      for (const [input, expected] of [
        [0, 0],
        [359, 359],
        [360, 0],
        [-1, 359],
        [-1.6, 358],
      ] as const) {
        const config = { colorPreset: "custom", customHue: input };
        expect(resolveColorHue(theme, config)).toBe(expected);
        const css = buildColorPresetCss(theme, config);
        expect(css).not.toBeNull();
        expectSyntacticThemeCss(css!, expected);
      }
    },
  );
});
