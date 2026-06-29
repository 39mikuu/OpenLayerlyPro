import { readFileSync } from "node:fs";
import path from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";

import type { MigrationIdentity } from "./types";

type JournalFile = {
  entries: Array<{
    tag: string;
    when: number;
  }>;
};

export function resolveMigrationsFolder(): string {
  return process.env.MIGRATIONS_FOLDER ?? path.join(process.cwd(), "src", "db", "migrations");
}

export function getTargetMigrationIdentity(
  migrationsFolder = resolveMigrationsFolder(),
): MigrationIdentity[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as JournalFile;
  const migrations = readMigrationFiles({ migrationsFolder });

  if (migrations.length !== journal.entries.length) {
    throw new Error("Migration journal and SQL files are out of sync");
  }

  return journal.entries.map((entry, index) => ({
    tag: entry.tag,
    hash: migrations[index]!.hash,
    createdAt: entry.when,
  }));
}
