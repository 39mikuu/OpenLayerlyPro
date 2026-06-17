import { describe, expect, it } from "vitest";

import { shouldShowMachineTranslationLabel } from "./policy";

describe("translation publish policies", () => {
  it("shows the machine marker only when the explicit policy is enabled", () => {
    expect(
      shouldShowMachineTranslationLabel({ showMachineTranslationLabel: true }, "machine"),
    ).toBe(true);
    expect(
      shouldShowMachineTranslationLabel({ showMachineTranslationLabel: false }, "machine"),
    ).toBe(false);
    expect(shouldShowMachineTranslationLabel({ showMachineTranslationLabel: true }, "manual")).toBe(
      false,
    );
  });
});
