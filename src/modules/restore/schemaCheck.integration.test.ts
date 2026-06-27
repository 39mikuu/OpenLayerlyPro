import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import { getTargetMigrationIdentity } from "./journal";
import { isSchemaCheckPassing, runRestoreSchemaCheck } from "./schemaCheck";
import * as schemaCompatibility from "./schemaCompatibility";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("restore schema check integration", () => {
  const db = getDb();
  let tempDir = "";

  beforeAll(async () => {
    await resetDatabase(db);
    tempDir = mkdtempSync(join(tmpdir(), "openlayerly-schema-check-"));
  });

  afterAll(async () => {
    await resetDatabase(db);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts a v2 manifest whose migration identity matches the target prefix", async () => {
    const history = getTargetMigrationIdentity().map((entry) => ({
      hash: entry.hash,
      createdAt: entry.createdAt,
    }));
    const manifestPath = join(tempDir, "manifest.env");
    writeFileSync(
      manifestPath,
      [
        "FORMAT_VERSION=2",
        `LATEST_MIGRATION_HASH=${history.at(-1)!.hash}`,
        `MIGRATION_IDENTITIES_JSON=${JSON.stringify(history)}`,
      ].join("\n"),
      "utf8",
    );

    const report = await runRestoreSchemaCheck({
      formatVersion: 2,
      manifestPath,
    });

    expect(isSchemaCheckPassing(report)).toBe(true);
    expect(report.compatibility.result).toBe("compatible");
  });

  it("rejects a v2 manifest whose latest hash is unknown to the target journal", async () => {
    const manifestPath = join(tempDir, "unknown-manifest.env");
    writeFileSync(
      manifestPath,
      [
        "FORMAT_VERSION=2",
        "LATEST_MIGRATION_HASH=deadbeef",
        'MIGRATION_IDENTITIES_JSON=[{"hash":"deadbeef","createdAt":1}]',
      ].join("\n"),
      "utf8",
    );

    const report = await runRestoreSchemaCheck({
      formatVersion: 2,
      manifestPath,
    });

    expect(isSchemaCheckPassing(report)).toBe(false);
    expect(report.compatibility.result).toBe("diverged");
  });

  it("allows v1 unknown override only when explicitly requested", async () => {
    const readHistory = vi
      .spyOn(schemaCompatibility, "readDatabaseMigrationHistory")
      .mockRejectedValueOnce(
        new schemaCompatibility.MigrationHistoryReadError("probe database unreadable"),
      );

    try {
      const report = await runRestoreSchemaCheck({
        formatVersion: 1,
        databaseUrl: process.env.DATABASE_URL,
        allowLegacyV1UnknownSchema: true,
      });

      expect(report.compatibility.result).toBe("unknown");
      expect(isSchemaCheckPassing(report)).toBe(true);
      expect(report.warnings.some((line) => line.includes("LEGACY OVERRIDE"))).toBe(true);
    } finally {
      readHistory.mockRestore();
    }
  });

  it("rejects v1 unknown schema by default", async () => {
    const readHistory = vi
      .spyOn(schemaCompatibility, "readDatabaseMigrationHistory")
      .mockRejectedValueOnce(
        new schemaCompatibility.MigrationHistoryReadError("probe database unreadable"),
      );

    try {
      const report = await runRestoreSchemaCheck({
        formatVersion: 1,
        databaseUrl: process.env.DATABASE_URL,
      });

      expect(report.compatibility.result).toBe("unknown");
      expect(isSchemaCheckPassing(report)).toBe(false);
    } finally {
      readHistory.mockRestore();
    }
  });

  it("accepts v1 archive history that matches the target journal prefix", async () => {
    const target = getTargetMigrationIdentity();
    const prefix = target.map((entry) => ({
      hash: entry.hash,
      createdAt: entry.createdAt,
    }));
    const readHistory = vi
      .spyOn(schemaCompatibility, "readDatabaseMigrationHistory")
      .mockResolvedValueOnce(prefix);

    try {
      const report = await runRestoreSchemaCheck({
        formatVersion: 1,
        databaseUrl: process.env.DATABASE_URL,
      });

      expect(report.compatibility.result).toBe("compatible");
      expect(isSchemaCheckPassing(report)).toBe(true);
      expect(
        report.warnings.some((line) => line.includes("FORMAT_VERSION=1 archive has no checksum")),
      ).toBe(true);
    } finally {
      readHistory.mockRestore();
    }
  });

  it("rejects v1 diverged histories before destructive restore", async () => {
    const target = getTargetMigrationIdentity();
    const diverged = [
      { hash: target[0]!.hash, createdAt: target[0]!.createdAt },
      { hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", createdAt: 2 },
    ];
    const readHistory = vi
      .spyOn(schemaCompatibility, "readDatabaseMigrationHistory")
      .mockResolvedValueOnce(diverged);

    try {
      const report = await runRestoreSchemaCheck({
        formatVersion: 1,
        databaseUrl: process.env.DATABASE_URL,
      });

      expect(report.compatibility.result).toBe("diverged");
      expect(isSchemaCheckPassing(report)).toBe(false);
    } finally {
      readHistory.mockRestore();
    }
  });

  it("reports newer_than_target when archive history exceeds target journal", async () => {
    const target = getTargetMigrationIdentity();
    const manifestPath = join(tempDir, "newer-manifest.env");
    const inflated = [
      ...target.map((entry) => ({ hash: entry.hash, createdAt: entry.createdAt })),
      { hash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", createdAt: 1 },
    ];
    writeFileSync(
      manifestPath,
      [
        "FORMAT_VERSION=2",
        `LATEST_MIGRATION_HASH=${inflated.at(-1)!.hash}`,
        `MIGRATION_IDENTITIES_JSON=${JSON.stringify(inflated)}`,
      ].join("\n"),
      "utf8",
    );

    const report = await runRestoreSchemaCheck({
      formatVersion: 2,
      manifestPath,
    });

    expect(isSchemaCheckPassing(report)).toBe(false);
    expect(report.compatibility.result).toBe("newer_than_target");
  });
});
