import { describe, expect, it } from "vitest";

import {
  ArchiveIntegrityError,
  comparePayloadAndManifest,
  parseChecksumManifestPaths,
  validateChecksumBijection,
} from "./archiveIntegrity";

const hash = "a".repeat(64);

function manifestLine(path: string): string {
  return `${hash}  ${path}`;
}

describe("archive integrity", () => {
  it("parses checksum manifest paths", () => {
    expect(
      parseChecksumManifestPaths([manifestLine("db.sql"), manifestLine("manifest.env")].join("\n")),
    ).toEqual(["db.sql", "manifest.env"]);
  });

  it("detects payload files missing from the manifest", () => {
    const mismatch = comparePayloadAndManifest(
      ["db.sql", "manifest.env", "secrets/config-encryption-key"],
      ["db.sql", "manifest.env"],
    );

    expect(mismatch.missingFromManifest).toEqual(["secrets/config-encryption-key"]);
    expect(mismatch.extraInManifest).toEqual([]);
  });

  it("detects manifest entries without payload files", () => {
    const mismatch = comparePayloadAndManifest(["db.sql"], ["db.sql", "uploads/missing.png"]);

    expect(mismatch.missingFromManifest).toEqual([]);
    expect(mismatch.extraInManifest).toEqual(["uploads/missing.png"]);
  });

  it("accepts an exact bijection", () => {
    const payload = ["db.sql", "manifest.env"];
    const manifest = payload.map((path) => manifestLine(path)).join("\n");

    expect(() => validateChecksumBijection(payload, manifest)).not.toThrow();
  });

  it("rejects tampered manifests before destructive restore steps", () => {
    const payload = ["db.sql", "manifest.env"];
    const manifest = [manifestLine("db.sql"), manifestLine("manifest.env.tampered")].join("\n");

    expect(() => validateChecksumBijection(payload, manifest)).toThrow(ArchiveIntegrityError);
  });
});
