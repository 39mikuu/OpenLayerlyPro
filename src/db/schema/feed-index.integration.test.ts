import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("public feed index migration", () => {
  it("creates the posts_public_feed_idx partial index", async () => {
    const rows = await getDb().execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef
        from pg_indexes
       where schemaname = 'public'
         and tablename = 'posts'
         and indexname = 'posts_public_feed_idx'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("(published_at DESC, id DESC)");
    expect(rows[0]!.indexdef).toContain("status = 'published'");
    expect(rows[0]!.indexdef).toContain("visibility = 'public'");
  });
});
