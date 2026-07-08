import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildColorPresetCss, normalizeHue, resolveColorHue } from "@/modules/theme/registry";
import type { Theme } from "@/modules/theme/types";
import { blogTheme } from "@/themes/blog";
import { builtinTheme } from "@/themes/builtin";
import { wordpressTheme } from "@/themes/wordpress";

const blogReusedBodySlots = ["PostDetail", "Tiers", "Login", "Me", "MeOrders", "Checkout"] as const;
const blogOverriddenSlots = ["Chrome", "Home", "PostList"] as const;
const wordpressReusedSlots = ["Tiers", "Login", "Me", "MeOrders", "Checkout"] as const;
const wordpressOverriddenSlots = ["Chrome", "Home", "PostList", "PostDetail"] as const;

function expectSyntacticThemeCss(css: string, expectedFragment: string) {
  expect(css).toContain(".site-theme{");
  expect(css).toContain(".dark .site-theme{");
  expect(css).toMatch(/--[a-z-]+: [^;{}]+;/);
  expect(css).toContain(expectedFragment);
  expect(css).not.toMatch(/NaN|undefined|null|:root|html/);
}

describe("blog theme component identity", () => {
  it("reuses builtin body components that have no theme-specific body implementation risk", () => {
    for (const slot of blogReusedBodySlots) {
      expect(blogTheme.components[slot]).toBeDefined();
      expect(builtinTheme.components[slot]).toBeDefined();
      expect(blogTheme.components[slot]).toBe(builtinTheme.components[slot]);
    }
  });

  it("overrides chrome, home and post list components", () => {
    for (const slot of blogOverriddenSlots) {
      expect(blogTheme.components[slot]).toBeDefined();
      expect(builtinTheme.components[slot]).toBeDefined();
      expect(blogTheme.components[slot]).not.toBe(builtinTheme.components[slot]);
    }
  });
});

describe("wordpress theme component identity", () => {
  it("reuses transactional/account body components from builtin", () => {
    for (const slot of wordpressReusedSlots) {
      expect(wordpressTheme.components[slot]).toBeDefined();
      expect(builtinTheme.components[slot]).toBeDefined();
      expect(wordpressTheme.components[slot]).toBe(builtinTheme.components[slot]);
    }
  });

  it("overrides classic blog surface components", () => {
    for (const slot of wordpressOverriddenSlots) {
      expect(wordpressTheme.components[slot]).toBeDefined();
      expect(builtinTheme.components[slot]).toBeDefined();
      expect(wordpressTheme.components[slot]).not.toBe(builtinTheme.components[slot]);
    }
  });
});

describe("real theme color preset and hue behavior", () => {
  const hueThemeCases: ReadonlyArray<[string, Theme]> = [
    ["builtin", builtinTheme],
    ["blog", blogTheme],
  ];

  it.each(hueThemeCases)("resolves every %s named preset", (_themeName, theme) => {
    for (const preset of theme.colorPresets) {
      const config = { colorPreset: preset.id };
      const expectedHue = preset.kind === "hue" ? preset.hue : null;
      expect(resolveColorHue(theme, config)).toBe(expectedHue);
      const css = buildColorPresetCss(theme, config);

      if (preset.kind === "none") {
        expect(css).toBeNull();
      } else if (preset.kind === "hue") {
        expect(css).not.toBeNull();
        expectSyntacticThemeCss(css!, ` ${preset.hue})`);
      }
    }
  });

  it("uses exact vars for wordpress presets and does not support custom hue", () => {
    expect(wordpressTheme.defaultColorPresetId).toBe("gofun-seiji");
    expect(wordpressTheme.colorVarsFromHue).toBeUndefined();
    expect(wordpressTheme.colorPresets.map((preset) => [preset.id, preset.name])).toEqual([
      ["gofun-seiji", "胡粉 × 墨 × 青磁"],
      ["layer-seal", "層印品牌"],
    ]);

    for (const preset of wordpressTheme.colorPresets) {
      expect(preset.kind).toBe("vars");
      if (preset.kind !== "vars") continue;
      expect(preset.cssVars.light).not.toHaveProperty("--destructive");
      expect(preset.cssVars.dark).not.toHaveProperty("--destructive");
      const css = buildColorPresetCss(wordpressTheme, { colorPreset: preset.id });
      expect(css).not.toBeNull();
      expectSyntacticThemeCss(css!, "--wordpress-seal");
    }

    expect(
      buildColorPresetCss(wordpressTheme, { colorPreset: "custom", customHue: 12 }),
    ).toBeNull();
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

  it.each(hueThemeCases)(
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
        expectSyntacticThemeCss(css!, ` ${expected})`);
      }
    },
  );
});
