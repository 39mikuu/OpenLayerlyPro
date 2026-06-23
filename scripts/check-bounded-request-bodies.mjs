import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const BODY_METHODS = new Set(["json", "text", "formData"]);
const HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
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

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function routeHandlerName(node) {
  if (ts.isFunctionDeclaration(node) && node.name && HTTP_METHODS.has(node.name.text)) {
    return node.name.text;
  }

  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name) &&
    HTTP_METHODS.has(node.parent.name.text)
  ) {
    return node.parent.name.text;
  }

  return null;
}

function collectRouteHandlers(sourceFile) {
  const handlers = [];

  function visit(node) {
    const name = routeHandlerName(node);
    if (name) handlers.push({ name, node });
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return handlers;
}

function isAliasExpression(expression, aliases) {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) && aliases.has(unwrapped.text);
}

function collectRequestAliases(handler) {
  const firstParameter = handler.parameters[0];
  if (!firstParameter || !ts.isIdentifier(firstParameter.name)) return new Set();

  const aliases = new Set([firstParameter.name.text]);
  let changed = true;

  while (changed) {
    changed = false;

    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isAliasExpression(node.initializer, aliases) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isAliasExpression(node.right, aliases) &&
        !aliases.has(node.left.text)
      ) {
        aliases.add(node.left.text);
        changed = true;
      }

      ts.forEachChild(node, visit);
    }

    if (handler.body) visit(handler.body);
  }

  return aliases;
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

  if (!method || !BODY_METHODS.has(method) || !target || !ts.isIdentifier(target)) return null;
  if (!aliases.has(target.text)) return null;
  return { requestName: target.text, method };
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
