import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ENTITLEMENT_KEYS } from "@/modules/membership/entitlement-keys";

import { SUPPORTED_LOCALES } from "./config";
import { en } from "./messages/en";
import { ja } from "./messages/ja";
import { zh } from "./messages/zh";
import { translate } from "./translate";

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

type TranslationUsage = {
  key: string;
  location: string;
};

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    if (!entry.isFile() || ![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) {
      return [];
    }
    return [path];
  });
}

function staticTranslationKeys(expression: ts.Expression): string[] {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return staticTranslationKeys(expression.expression);
  }
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isConditionalExpression(expression)) {
    return [
      ...staticTranslationKeys(expression.whenTrue),
      ...staticTranslationKeys(expression.whenFalse),
    ];
  }
  return [];
}

function collectStaticTranslationUsages(sourceRoot: string): TranslationUsage[] {
  return productionSourceFiles(sourceRoot).flatMap((path) => {
    const sourceFile = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const usages: TranslationUsage[] = [];

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const keyArgumentIndex =
          node.expression.text === "t" ? 0 : node.expression.text === "translate" ? 1 : -1;
        const keyArgument = keyArgumentIndex >= 0 ? node.arguments[keyArgumentIndex] : undefined;
        if (keyArgument) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            keyArgument.getStart(sourceFile),
          );
          for (const key of staticTranslationKeys(keyArgument)) {
            if (key.includes(".")) {
              usages.push({
                key,
                location: `${relative(sourceRoot, path)}:${line + 1}`,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return usages;
  });
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

  it("has label and description copy for every entitlement in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const entitlement of ENTITLEMENT_KEYS) {
        for (const field of ["label", "description"] as const) {
          const key = `entitlements.${entitlement}.${field}`;
          expect(translate(locale, key), `${locale} is missing ${key}`).not.toBe(key);
        }
      }
    }
  });

  it("defines every statically referenced production translation key", () => {
    const definedKeys = new Set(zhKeyPaths);
    const missing = collectStaticTranslationUsages(join(process.cwd(), "src"))
      .filter(({ key }) => !definedKeys.has(key))
      .map(({ key, location }) => `${key} (${location})`)
      .sort();

    expect(missing).toEqual([]);
  });
});
