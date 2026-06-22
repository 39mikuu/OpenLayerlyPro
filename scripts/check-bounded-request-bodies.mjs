import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const BODY_METHODS = new Set(["json", "text", "formData"]);
const REQUEST_NAMES = new Set(["req", "request"]);
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

export function findDirectBodyReads(source, fileName = "route.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      const method = node.expression.name.text;
      if (ts.isIdentifier(target) && REQUEST_NAMES.has(target.text) && BODY_METHODS.has(method)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({
          line: position.line + 1,
          column: position.character + 1,
          requestName: target.text,
          method,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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
  const root = process.argv[2] ?? "src/app/api";
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
