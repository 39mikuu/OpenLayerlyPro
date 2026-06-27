import { sql } from "drizzle-orm";

import type { DbClient } from "@/db";

import type {
  MigrationHistoryEntry,
  MigrationIdentity,
  SchemaCompatibilityReport,
  SchemaCompatibilityResult,
} from "./types";

export class MigrationHistoryReadError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MigrationHistoryReadError";
  }
}

export async function readDatabaseMigrationHistory(db: DbClient): Promise<MigrationHistoryEntry[]> {
  try {
    const rows = await db.execute<{
      hash: string;
      created_at: string;
    }>(sql`select hash, created_at::text as created_at from __drizzle_migrations order by id asc`);

    return rows.map((row) => ({
      hash: row.hash,
      createdAt: Number(row.created_at),
    }));
  } catch (error) {
    throw new MigrationHistoryReadError("Unable to read __drizzle_migrations", error);
  }
}

export function compareMigrationHistories(
  archive: MigrationHistoryEntry[] | null,
  target: MigrationIdentity[],
): SchemaCompatibilityReport {
  if (archive === null) {
    return {
      result: "unknown",
      archiveLength: 0,
      targetLength: target.length,
      firstMismatchIndex: null,
      reason: "archive migration history unavailable",
    };
  }

  if (archive.length > target.length) {
    return {
      result: "newer_than_target",
      archiveLength: archive.length,
      targetLength: target.length,
      firstMismatchIndex: target.length,
      reason: "archive migration history is longer than target journal",
    };
  }

  for (let index = 0; index < archive.length; index += 1) {
    if (archive[index]!.hash !== target[index]!.hash) {
      return {
        result: "diverged",
        archiveLength: archive.length,
        targetLength: target.length,
        firstMismatchIndex: index,
        reason: `migration hash mismatch at index ${index}`,
      };
    }
  }

  return {
    result: "compatible",
    archiveLength: archive.length,
    targetLength: target.length,
    firstMismatchIndex: null,
  };
}

export function isSchemaCompatible(result: SchemaCompatibilityResult): boolean {
  return result === "compatible";
}

export function archiveHistoryFromLatestHash(
  latestHash: string,
  target: MigrationIdentity[],
): MigrationHistoryEntry[] | null {
  const index = target.findIndex((entry) => entry.hash === latestHash);
  if (index === -1) return null;
  return target.slice(0, index + 1).map((entry) => ({
    hash: entry.hash,
    createdAt: entry.createdAt,
  }));
}
