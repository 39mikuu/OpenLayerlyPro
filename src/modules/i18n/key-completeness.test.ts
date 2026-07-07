import { describe, expect, it } from "vitest";

import { en } from "./messages/en";
import { ja } from "./messages/ja";
import { zh } from "./messages/zh";

/**
 * en.ts/ja.ts already declare `: Messages` (the type derived from zh.ts's own
 * shape via `typeof zh`), so tsc's excess-property + missing-property checks
 * already reject any key drift at compile time. This test formalizes that
 * invariant as an explicit, named, CI-visible check (issue #101 known-gaps G4)
 * with diagnostics that list every missing/extra path at once, rather than
 * tsc's first-divergence-only error.
 */
function collectKeyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    collectKeyPaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

function keyDiff(reference: string[], candidate: string[]): { missing: string[]; extra: string[] } {
  const referenceSet = new Set(reference);
  const candidateSet = new Set(candidate);
  return {
    missing: reference.filter((path) => !candidateSet.has(path)),
    extra: candidate.filter((path) => !referenceSet.has(path)),
  };
}

describe("i18n message key completeness (G4)", () => {
  const zhKeyPaths = collectKeyPaths(zh);

  it.each([
    ["en", en],
    ["ja", ja],
  ] as const)("%s has exactly the same message key set as zh", (locale, messages) => {
    const { missing, extra } = keyDiff(zhKeyPaths, collectKeyPaths(messages));
    expect({ locale, missing, extra }).toEqual({ locale, missing: [], extra: [] });
  });
});
