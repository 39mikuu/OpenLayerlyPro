import { describe, expect, it } from "vitest";

import { getTargetMigrationIdentity } from "@/modules/restore/journal";

import { RUNTIME_SCHEMA_MIGRATIONS } from "./runtime-schema";

describe("RUNTIME_SCHEMA_MIGRATIONS", () => {
  it("matches the complete ordered migration journal and SQL hashes", () => {
    const target = getTargetMigrationIdentity();

    expect(target).toEqual(RUNTIME_SCHEMA_MIGRATIONS);
  });
});
