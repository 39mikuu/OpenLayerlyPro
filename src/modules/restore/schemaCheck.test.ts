import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getTargetMigrationIdentity } from "./journal";
import { runRestoreSchemaCheck } from "./schemaCheck";

describe("runRestoreSchemaCheck manifest warnings", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openlayerly-schema-check-unit-"));
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  function writeMatchingManifest(formatVersion: 2 | 3): string {
    const history = getTargetMigrationIdentity().map((entry) => ({
      hash: entry.hash,
      createdAt: entry.createdAt,
    }));
    const manifestPath = join(tempDir, `manifest-v${formatVersion}.env`);
    writeFileSync(
      manifestPath,
      [
        `FORMAT_VERSION=${formatVersion}`,
        `LATEST_MIGRATION_HASH=${history.at(-1)!.hash}`,
        `MIGRATION_IDENTITIES_JSON=${JSON.stringify(history)}`,
      ].join("\n"),
      "utf8",
    );
    return manifestPath;
  }

  it("warns that v1 archives predate checksums, migration identity, and image provenance", async () => {
    const report = await runRestoreSchemaCheck({
      formatVersion: 1,
    });

    expect(report.warnings).toContain(
      "FORMAT_VERSION=1 archive has no checksum protection, manifest migration identity, or image-authoritative provenance",
    );
    expect(report.warnings).toContain("v1 schema probe requires --database-url");
  });

  it("warns that v2 archives predate image-authoritative provenance", async () => {
    const report = await runRestoreSchemaCheck({
      formatVersion: 2,
      manifestPath: writeMatchingManifest(2),
    });

    expect(report.compatibility.result).toBe("compatible");
    expect(report.warnings).toContain(
      "FORMAT_VERSION=2 archive predates image-authoritative provenance; runtime version/commit/image identity are informational only when present",
    );
  });

  it("does not warn for v3 image-authoritative provenance when migration identity matches", async () => {
    const report = await runRestoreSchemaCheck({
      formatVersion: 3,
      manifestPath: writeMatchingManifest(3),
    });

    expect(report.compatibility.result).toBe("compatible");
    expect(report.warnings).toEqual([]);
  });
});
