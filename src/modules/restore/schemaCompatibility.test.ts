import { describe, expect, it } from "vitest";

import { getTargetMigrationIdentity } from "./journal";
import {
  archiveHistoryFromLatestHash,
  compareMigrationHistories,
  isSchemaCompatible,
} from "./schemaCompatibility";

describe("compareMigrationHistories", () => {
  const target = [
    { tag: "0000_a", hash: "hash-0", createdAt: 1 },
    { tag: "0001_b", hash: "hash-1", createdAt: 2 },
    { tag: "0002_c", hash: "hash-2", createdAt: 3 },
  ];

  it("accepts an equal-order equal-hash prefix", () => {
    const report = compareMigrationHistories(
      [
        { hash: "hash-0", createdAt: 1 },
        { hash: "hash-1", createdAt: 2 },
      ],
      target,
    );

    expect(report.result).toBe("compatible");
    expect(isSchemaCompatible(report.result)).toBe(true);
  });

  it("rejects archives newer than the target journal", () => {
    const report = compareMigrationHistories(
      [
        { hash: "hash-0", createdAt: 1 },
        { hash: "hash-1", createdAt: 2 },
        { hash: "hash-2", createdAt: 3 },
        { hash: "hash-3", createdAt: 4 },
      ],
      target,
    );

    expect(report.result).toBe("newer_than_target");
    expect(report.firstMismatchIndex).toBe(3);
  });

  it("rejects diverged histories", () => {
    const report = compareMigrationHistories(
      [
        { hash: "hash-0", createdAt: 1 },
        { hash: "different", createdAt: 2 },
      ],
      target,
    );

    expect(report.result).toBe("diverged");
    expect(report.firstMismatchIndex).toBe(1);
  });

  it("treats unavailable archive history as unknown", () => {
    const report = compareMigrationHistories(null, target);
    expect(report.result).toBe("unknown");
  });

  it("treats an empty archive history as compatible", () => {
    const report = compareMigrationHistories([], target);
    expect(report.result).toBe("compatible");
  });
});

describe("archiveHistoryFromLatestHash", () => {
  it("derives a target prefix from the latest applied hash", () => {
    const target = getTargetMigrationIdentity();
    const latest = target[target.length - 1]!;
    const archive = archiveHistoryFromLatestHash(latest.hash, target);

    expect(archive).not.toBeNull();
    expect(archive!.map((entry) => entry.hash)).toEqual(target.map((entry) => entry.hash));
  });
});
