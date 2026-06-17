import { describe, expect, it } from "vitest";

import {
  BUILTIN_COLOR_PRESETS,
  BUILTIN_DEFAULT_COLOR_PRESET_ID,
  colorVarsFromHue,
} from "./color-presets";

describe("builtin creator support palette", () => {
  it("uses the FANBOX-like blue preset by default", () => {
    expect(BUILTIN_DEFAULT_COLOR_PRESET_ID).toBe("blue");
    expect(
      BUILTIN_COLOR_PRESETS.find((preset) => preset.id === BUILTIN_DEFAULT_COLOR_PRESET_ID),
    ).toMatchObject({ hue: 256 });
    expect(colorVarsFromHue(256).light["--primary"]).toContain("256");
  });
});
