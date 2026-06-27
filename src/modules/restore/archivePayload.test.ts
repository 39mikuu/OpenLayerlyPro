import { describe, expect, it } from "vitest";

import { ARCHIVE_CHECKSUM_MANIFEST, listArchivePayloadRelativePaths } from "./archivePayload";

describe("listArchivePayloadRelativePaths", () => {
  it("excludes only the root checksum manifest", () => {
    expect(
      listArchivePayloadRelativePaths([
        "db.sql",
        ARCHIVE_CHECKSUM_MANIFEST,
        "uploads/nested/checksums.sha256",
        "manifest.env",
      ]),
    ).toEqual(["db.sql", "manifest.env", "uploads/nested/checksums.sha256"]);
  });
});
