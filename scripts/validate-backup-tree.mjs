#!/usr/bin/env node

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
const label = process.argv[3] ?? "backup tree";

if (!root) {
  console.error("usage: validate-backup-tree.mjs <root> [label]");
  process.exit(2);
}

function validateName(name, relativePath) {
  if (/[\u0000-\u001f\u007f\\]/u.test(name)) {
    throw new Error(
      `${label} contains a filename outside the supported checksum grammar: ${JSON.stringify(relativePath)}`,
    );
  }
}

async function walk(currentPath, relativePath) {
  const stat = await lstat(currentPath);

  if (stat.isSymbolicLink()) {
    throw new Error(`${label} contains a symlink: ${relativePath || "."}`);
  }
  if (stat.isFile()) {
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} contains a special file: ${relativePath || "."}`);
  }

  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name;
    validateName(entry.name, childRelative);
    await walk(path.join(currentPath, entry.name), childRelative);
  }
}

try {
  await walk(root, "");
} catch (error) {
  console.error(
    `backup: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
