import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

const SOURCE_ROOT = path.resolve("src");
const TASK_ROOT = path.join(SOURCE_ROOT, "modules", "tasks");
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TASK_BARREL_FILES = [
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.cts",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
];
const FORBIDDEN_ABSOLUTE_SPECIFIERS = new Set(["@/modules/tasks", "@/modules/tasks/index"]);

async function collectSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(absolute)));
    else if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name)) files.push(absolute);
  }
  return files;
}

function sourceFileKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function findForbiddenSpecifiers(sourceFile, file) {
  const findings = [];

  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      const forbiddenAbsolute = FORBIDDEN_ABSOLUTE_SPECIFIERS.has(node.text);
      const resolvedRelative = node.text.startsWith(".")
        ? path.resolve(path.dirname(file), node.text)
        : null;
      const forbiddenRelative =
        resolvedRelative === TASK_ROOT || resolvedRelative === path.join(TASK_ROOT, "index");
      if (forbiddenAbsolute || forbiddenRelative) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({
          line: position.line + 1,
          column: position.character + 1,
          specifier: node.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const failures = [];
for (const barrelFile of TASK_BARREL_FILES) {
  if (await fileExists(path.join(TASK_ROOT, barrelFile))) {
    failures.push(
      `src/modules/tasks/${barrelFile} must not exist; import the explicit enqueue, runtime, admin, operational-snapshot, errors, or queue-class boundary.`,
    );
  }
}

for (const file of await collectSourceFiles(SOURCE_ROOT)) {
  const source = await readFile(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourceFileKind(file),
  );
  for (const finding of findForbiddenSpecifiers(sourceFile, file)) {
    failures.push(
      `${path.relative(process.cwd(), file)}:${finding.line}:${finding.column} imports forbidden task barrel ${finding.specifier}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Task module boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Task module boundaries are explicit.");
}
