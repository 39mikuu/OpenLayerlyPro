import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";

import { getTargetMigrationIdentity } from "./journal";
import {
  archiveHistoryFromLatestHash,
  compareMigrationHistories,
  isSchemaCompatible,
  MigrationHistoryReadError,
  readDatabaseMigrationHistory,
} from "./schemaCompatibility";
import type { MigrationHistoryEntry, SchemaCheckReport } from "./types";

export type SchemaCheckInput = {
  databaseUrl?: string;
  formatVersion: number;
  manifestPath?: string;
  allowLegacyV1UnknownSchema?: boolean;
};

function parseManifestEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values[key] = value;
  }
  return values;
}

function readManifestMigrationHistory(manifestPath: string): MigrationHistoryEntry[] | null {
  const manifest = parseManifestEnv(readFileSync(manifestPath, "utf8"));

  if (manifest.MIGRATION_IDENTITIES_JSON) {
    try {
      const parsed = JSON.parse(manifest.MIGRATION_IDENTITIES_JSON) as MigrationHistoryEntry[];
      if (!Array.isArray(parsed)) return null;
      return parsed.map((entry) => ({
        hash: entry.hash,
        createdAt: Number(entry.createdAt),
      }));
    } catch {
      return null;
    }
  }

  const latestHash = manifest.LATEST_MIGRATION_HASH?.trim();
  if (!latestHash) return null;
  return archiveHistoryFromLatestHash(latestHash, getTargetMigrationIdentity());
}

async function readArchiveHistoryFromDatabase(
  databaseUrl: string,
): Promise<MigrationHistoryEntry[] | null> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(client, { schema });
    return await readDatabaseMigrationHistory(db);
  } catch (error) {
    if (error instanceof MigrationHistoryReadError) return null;
    throw error;
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

export async function runRestoreSchemaCheck(input: SchemaCheckInput): Promise<SchemaCheckReport> {
  const warnings: string[] = [];
  const target = getTargetMigrationIdentity();
  let archiveHistory: MigrationHistoryEntry[] | null = null;

  if (input.formatVersion === 1) {
    warnings.push(
      "FORMAT_VERSION=1 archive has no checksum protection or manifest migration identity",
    );
    if (!input.databaseUrl) {
      return {
        formatVersion: input.formatVersion,
        compatibility: compareMigrationHistories(null, target),
        allowLegacyV1UnknownSchema: input.allowLegacyV1UnknownSchema === true,
        warnings: [...warnings, "v1 schema probe requires --database-url"],
      };
    }
    archiveHistory = await readArchiveHistoryFromDatabase(input.databaseUrl);
  } else if (input.formatVersion >= 2) {
    if (!input.manifestPath) {
      return {
        formatVersion: input.formatVersion,
        compatibility: compareMigrationHistories(null, target),
        allowLegacyV1UnknownSchema: false,
        warnings: ["FORMAT_VERSION>=2 schema check requires --manifest-path"],
      };
    }
    archiveHistory = readManifestMigrationHistory(input.manifestPath);
    if (archiveHistory === null) {
      warnings.push("manifest migration identity missing or unreadable");
    }
  } else {
    return {
      formatVersion: input.formatVersion,
      compatibility: compareMigrationHistories(null, target),
      allowLegacyV1UnknownSchema: false,
      warnings: [`unsupported FORMAT_VERSION=${input.formatVersion}`],
    };
  }

  const compatibility = compareMigrationHistories(archiveHistory, target);
  const allowLegacyV1UnknownSchema = input.allowLegacyV1UnknownSchema === true;

  if (compatibility.result === "unknown" && allowLegacyV1UnknownSchema) {
    warnings.push(
      "LEGACY OVERRIDE: proceeding despite unknown archive migration history; operator accepts schema risk",
    );
  }

  return {
    formatVersion: input.formatVersion,
    compatibility,
    allowLegacyV1UnknownSchema,
    warnings,
  };
}

export function isSchemaCheckPassing(report: SchemaCheckReport): boolean {
  if (isSchemaCompatible(report.compatibility.result)) return true;
  return (
    report.formatVersion === 1 &&
    report.allowLegacyV1UnknownSchema &&
    report.compatibility.result === "unknown"
  );
}
