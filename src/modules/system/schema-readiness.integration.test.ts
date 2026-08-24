import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db";

import { isRuntimeSchemaCurrent } from "./schema-readiness";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("runtime schema readiness", () => {
  it("accepts the migrated database and rejects an earlier timestamp drift", async () => {
    const rollback = new Error("rollback runtime schema readiness test");

    await expect(
      getDb().transaction(async (tx) => {
        await expect(isRuntimeSchemaCurrent(tx)).resolves.toBe(true);

        await tx.execute(sql`
          update drizzle.__drizzle_migrations
             set created_at = created_at + 1
           where id = (select min(id) from drizzle.__drizzle_migrations)
        `);

        await expect(isRuntimeSchemaCurrent(tx)).resolves.toBe(false);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
