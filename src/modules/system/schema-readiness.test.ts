import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/db";
import { RUNTIME_SCHEMA_MIGRATIONS } from "@/db/runtime-schema";

import { isRuntimeSchemaCurrent } from "./schema-readiness";

type MigrationRow = { hash: string; created_at: string };

function runtimeRows(): MigrationRow[] {
  return RUNTIME_SCHEMA_MIGRATIONS.map((migration) => ({
    hash: migration.hash,
    created_at: String(migration.createdAt),
  }));
}

function mockDb(rows: MigrationRow[]): DbClient {
  return {
    execute: vi.fn().mockResolvedValue(rows),
  } as unknown as DbClient;
}

describe("isRuntimeSchemaCurrent", () => {
  it("accepts the complete ordered runtime migration history", async () => {
    await expect(isRuntimeSchemaCurrent(mockDb(runtimeRows()))).resolves.toBe(true);
  });

  it.each([
    ["missing history", []],
    ["a missing middle migration", runtimeRows().filter((_row, index) => index !== 12)],
    [
      "an earlier migration hash drift",
      runtimeRows().map((row, index) => (index === 4 ? { ...row, hash: "different-hash" } : row)),
    ],
    [
      "an earlier migration timestamp drift",
      runtimeRows().map((row, index) =>
        index === 6 ? { ...row, created_at: String(Number(row.created_at) + 1) } : row,
      ),
    ],
    ["reordered migrations", runtimeRows().toSpliced(8, 2, runtimeRows()[9]!, runtimeRows()[8]!)],
    ["a newer migration", [...runtimeRows(), { hash: "future-hash", created_at: "9999999999999" }]],
  ])("rejects %s", async (_label, rows) => {
    await expect(isRuntimeSchemaCurrent(mockDb(rows))).resolves.toBe(false);
  });

  it("propagates migration history query failures", async () => {
    const failure = new Error("missing migration table");
    const db = {
      execute: vi.fn().mockRejectedValue(failure),
    } as unknown as DbClient;

    await expect(isRuntimeSchemaCurrent(db)).rejects.toBe(failure);
  });
});
