import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import {
  BODY_METHODS,
  collectRequestAliases,
  collectRouteHandlers,
  isRequestCloneExpression,
  isRequestConstructionExpression,
  unwrapExpression,
} from "./lib/route-ast.mjs";

const ROUTE_FILE_PATTERN = /^route\.(?:[cm]?[jt]sx?)$/;

async function collectRouteFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectRouteFiles(absolute)));
    else if (entry.isFile() && ROUTE_FILE_PATTERN.test(entry.name)) files.push(absolute);
  }
  return files;
}

function getBodyRead(call, aliases) {
  const callee = unwrapExpression(call.expression);
  let target;
  let method;

  if (ts.isPropertyAccessExpression(callee)) {
    target = unwrapExpression(callee.expression);
    method = callee.name.text;
  } else if (ts.isElementAccessExpression(callee)) {
    target = unwrapExpression(callee.expression);
    const argument = callee.argumentExpression && unwrapExpression(callee.argumentExpression);
    if (argument && ts.isStringLiteralLike(argument)) method = argument.text;
  }

  if (!method || !BODY_METHODS.has(method) || !target) return null;
  if (ts.isIdentifier(target) && aliases.has(target.text))
    return { requestName: target.text, method };
  if (isRequestCloneExpression(target, aliases)) return { requestName: "request.clone()", method };
  if (isRequestConstructionExpression(target, aliases))
    return { requestName: "new Request", method };
  return null;
}

function expressionContainsRequestAlias(expression, aliases) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return aliases.has(unwrapped.text);
  if (isRequestCloneExpression(unwrapped, aliases)) return true;
  if (isRequestConstructionExpression(unwrapped, aliases)) return true;
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return expressionContainsRequestAlias(property.initializer, aliases);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return expressionContainsRequestAlias(property.name, aliases);
      }
      if (ts.isSpreadAssignment(property)) {
        return expressionContainsRequestAlias(property.expression, aliases);
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.some((element) => {
      if (ts.isSpreadElement(element)) {
        return expressionContainsRequestAlias(element.expression, aliases);
      }
      return expressionContainsRequestAlias(element, aliases);
    });
  }
  return false;
}

function getRequestContainerEscape(node, aliases) {
  if (!ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node)) return null;
  if (!expressionContainsRequestAlias(node, aliases)) return null;
  return { requestName: "request container", method: "container" };
}

export function findDirectBodyReads(source, fileName = "route.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];

  for (const { node: handler } of collectRouteHandlers(sourceFile)) {
    const aliases = collectRequestAliases(handler);
    if (aliases.size === 0) continue;

    function visit(node) {
      if (ts.isCallExpression(node)) {
        const bodyRead = getBodyRead(node, aliases);
        if (bodyRead) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            line: position.line + 1,
            column: position.character + 1,
            ...bodyRead,
          });
        }
      }
      if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
        const containerEscape = getRequestContainerEscape(node, aliases);
        if (containerEscape) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            line: position.line + 1,
            column: position.character + 1,
            ...containerEscape,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    if (handler.body) visit(handler.body);
  }

  return violations;
}

export async function checkRouteTree(root) {
  const absoluteRoot = path.resolve(root);
  const routeFiles = await collectRouteFiles(absoluteRoot);
  const violations = [];

  for (const file of routeFiles.sort()) {
    const source = await readFile(file, "utf8");
    for (const violation of findDirectBodyReads(source, file)) {
      violations.push({ file, ...violation });
    }
  }

  return violations;
}

async function main() {
  const root = process.argv[2] ?? "src/app";
  const violations = await checkRouteTree(root);
  if (violations.length === 0) {
    console.log(`Bounded request-body check passed (${path.resolve(root)})`);
    return;
  }

  console.error("Direct request body reads are forbidden in production Route Handlers:");
  for (const violation of violations) {
    const relative = path.relative(process.cwd(), violation.file) || violation.file;
    console.error(
      `${relative}:${violation.line}:${violation.column}: use a bounded request-body helper instead of ${violation.requestName}.${violation.method}()`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
