import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

type TranslationBindingKind = "bound" | "direct" | "factory";

function collectStaticTranslationUsages(sourceRoot: string): TranslationUsage[] {
  const paths = productionSourceFiles(sourceRoot);
  const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const program = ts.createProgram({ rootNames: paths, options: parsed.options });
  const checker = program.getTypeChecker();
  const kindCache = new Map<ts.Symbol, TranslationBindingKind | null>();
  const resolving = new Set<ts.Symbol>();

  function resolveAlias(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  }

  function isTranslateType(type: ts.Type): boolean {
    const candidates = [type.aliasSymbol, type.getSymbol()].filter(
      (symbol): symbol is ts.Symbol => symbol !== undefined,
    );
    return candidates.some((candidate) => {
      const symbol = resolveAlias(candidate);
      return (
        symbol.name === "Translate" &&
        (symbol.declarations ?? []).some((declaration) =>
          declaration
            .getSourceFile()
            .fileName.replaceAll("\\", "/")
            .endsWith("/modules/i18n/runtime.ts"),
        )
      );
    });
  }

  function unwrapExpression(expression: ts.Expression): ts.Expression {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isAwaitExpression(expression)
    ) {
      return unwrapExpression(expression.expression);
    }
    return expression;
  }

  function importBindingKind(declaration: ts.ImportSpecifier): TranslationBindingKind | null {
    const importDeclaration = declaration.parent.parent.parent;
    if (!ts.isImportDeclaration(importDeclaration)) return null;
    const moduleName = ts.isStringLiteral(importDeclaration.moduleSpecifier)
      ? importDeclaration.moduleSpecifier.text
      : "";
    const importedName = declaration.propertyName?.text ?? declaration.name.text;
    if (
      importedName === "translate" &&
      ["@/modules/i18n", "@/modules/i18n/translate", "./translate"].includes(moduleName)
    ) {
      return "direct";
    }
    if (importedName === "useT" && moduleName === "@/components/i18n-provider") {
      return "factory";
    }
    if (importedName === "getT" && moduleName === "@/modules/i18n/server") {
      return "factory";
    }
    return null;
  }

  function expressionBindingKind(expression: ts.Expression): TranslationBindingKind | null {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      const symbol = checker.getSymbolAtLocation(unwrapped);
      return symbol ? symbolBindingKind(symbol) : null;
    }
    if (ts.isCallExpression(unwrapped)) {
      return expressionBindingKind(unwrapped.expression) === "factory" ? "bound" : null;
    }
    if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
      return functionReturnsDirectTranslation(unwrapped) ? "bound" : null;
    }
    return null;
  }

  function functionReturnsDirectTranslation(
    declaration: ts.ArrowFunction | ts.FunctionExpression,
  ): boolean {
    function isDirectTranslationCall(expression: ts.Expression): boolean {
      const unwrapped = unwrapExpression(expression);
      return (
        ts.isCallExpression(unwrapped) &&
        expressionBindingKind(unwrapped.expression) === "direct"
      );
    }

    if (!ts.isBlock(declaration.body)) {
      return isDirectTranslationCall(declaration.body);
    }

    let found = false;
    function visit(node: ts.Node) {
      if (found) return;
      if (node !== declaration.body && ts.isFunctionLike(node)) return;
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        isDirectTranslationCall(node.expression)
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(declaration.body);
    return found;
  }

  function functionDeclarationKind(
    declaration: ts.FunctionDeclaration,
  ): TranslationBindingKind | null {
    if (!declaration.body) return null;
    let factory = false;
    function visit(node: ts.Node) {
      if (factory) return;
      if (node !== declaration.body && ts.isFunctionLike(node)) return;
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        expressionBindingKind(node.expression) === "bound"
      ) {
        factory = true;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(declaration.body);
    return factory ? "factory" : null;
  }

  function symbolBindingKind(symbol: ts.Symbol): TranslationBindingKind | null {
    const cached = kindCache.get(symbol);
    if (cached !== undefined) return cached;
    if (resolving.has(symbol)) return null;
    resolving.add(symbol);
    let kind: TranslationBindingKind | null = null;
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(declaration)) kind ??= importBindingKind(declaration);
      else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        kind ??= expressionBindingKind(declaration.initializer);
      } else if (ts.isParameter(declaration) || ts.isBindingElement(declaration)) {
        kind ??= isTranslateType(checker.getTypeAtLocation(declaration.name)) ? "bound" : null;
      } else if (ts.isFunctionDeclaration(declaration)) {
        kind ??= functionDeclarationKind(declaration);
      }
      if (kind) break;
    }
    resolving.delete(symbol);
    kindCache.set(symbol, kind);
    return kind;
  }

  return paths.flatMap((path) => {
    const sourceFile = program.getSourceFile(path);
    if (!sourceFile) throw new Error(`TypeScript program did not load ${path}`);
    const usages: TranslationUsage[] = [];

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const bindingKind = expressionBindingKind(node.expression);
        const keyArgumentIndex = bindingKind === "bound" ? 0 : bindingKind === "direct" ? 1 : -1;
        const keyArgument = keyArgumentIndex >= 0 ? node.arguments[keyArgumentIndex] : undefined;
        if (keyArgument) {
          const { line } = sourceFile!.getLineAndCharacterOfPosition(
            keyArgument.getStart(sourceFile!),
          );
          for (const key of staticTranslationKeys(keyArgument)) {
            usages.push({
              key,
              location: `${relative(sourceRoot, path)}:${line + 1}`,
            });
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
  }, 30_000);

  it("distinguishes translation API aliases from unrelated same-name functions", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-binding-scan-"));
    try {
      writeFileSync(
        join(fixtureRoot, "bindings.ts"),
        `
          import { useT as useTranslate } from "@/components/i18n-provider";
          import { translate as renderMessage } from "@/modules/i18n";
          import type { Translate } from "@/modules/i18n";
          import { getT } from "@/modules/i18n/server";

          function t(state: string) { return state; }

          export function render(locale: "en") {
            const message = useTranslate();
            const handler = (event: string) => {
              renderMessage(locale, "audit.created");
              return event;
            };
            t("business-state");
            handler("business-handler");
            message("nav.posts");
            renderMessage(locale, "nav.home");
          }

          export function renderProp({ translator }: { translator: Translate }) {
            translator("nav.login");
          }

          export async function renderServer() {
            const [serverTranslate] = await Promise.all([getT()]);
            serverTranslate("nav.logout");
          }
        `,
        "utf8",
      );

      expect(collectStaticTranslationUsages(fixtureRoot).map(({ key }) => key)).toEqual([
        "nav.posts",
        "nav.home",
        "nav.login",
        "nav.logout",
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
