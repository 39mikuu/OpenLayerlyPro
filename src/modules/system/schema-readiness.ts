import { sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { RUNTIME_SCHEMA_MIGRATIONS } from "@/db/runtime-schema";

/**
 * Confirms that the database was migrated by the same migration set expected
 * by this application image. Query errors intentionally propagate so the
 * readiness boundary can fail closed without exposing internal details.
 */
export async function isRuntimeSchemaCurrent(db: DbClient): Promise<boolean> {
  const rows = await db.execute<{ hash: string; created_at: string }>(sql`
    select hash, created_at::text as created_at
      from drizzle.__drizzle_migrations
     order by id asc
  `);

  return (
    rows.length === RUNTIME_SCHEMA_MIGRATIONS.length &&
    rows.every((row, index) => {
      const expected = RUNTIME_SCHEMA_MIGRATIONS[index]!;
      return row.hash === expected.hash && Number(row.created_at) === expected.createdAt;
    })
  );
}
