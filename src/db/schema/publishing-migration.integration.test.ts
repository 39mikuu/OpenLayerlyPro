import { sql } from "drizzle-orm";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const MIGRATIONS_DIR = join(process.cwd(), "src/db/migrations");

function migrationStatements(fileName: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, fileName), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describeWithDatabase("scheduled publishing migration", () => {
  it("backfills legacy content time and enforces scheduling and publishing constraints", async () => {
    const db = getDb();
    const schemaName = `issue9_migration_${Date.now()}`;

    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`create schema "${schemaName}"`));
      await tx.execute(sql.raw(`set local search_path to "${schemaName}", public`));

      for (let index = 0; index <= 9; index += 1) {
        const fileName = readMigrationName(index);
        for (const statement of migrationStatements(fileName)) {
          await tx.execute(sql.raw(statement));
        }
      }

      const legacyUpdatedAt = "2025-04-03T02:01:00.000Z";
      const legacyId = "11111111-1111-4111-8111-111111111111";
      await tx.execute(
        sql.raw(`
          insert into posts (
            id, title, slug, original_locale, visibility, status, created_at, updated_at
          ) values (
            '${legacyId}', 'Legacy post', 'legacy-post', 'zh', 'public', 'draft',
            '${legacyUpdatedAt}', '${legacyUpdatedAt}'
          )
        `),
      );

      for (const statement of migrationStatements("0010_nostalgic_killraven.sql")) {
        await tx.execute(sql.raw(statement));
      }

      const backfilled = await tx.execute<{
        scheduled_at: string | null;
        schedule_token: string | null;
        content_updated_at: string;
        updated_at: string;
      }>(
        sql.raw(`select scheduled_at, schedule_token, content_updated_at, updated_at
                  from posts where id = '${legacyId}'`),
      );
      expect(backfilled[0]).toMatchObject({
        scheduled_at: null,
        schedule_token: null,
      });
      expect(new Date(backfilled[0]!.content_updated_at).toISOString()).toBe(legacyUpdatedAt);
      expect(new Date(backfilled[0]!.updated_at).toISOString()).toBe(legacyUpdatedAt);

      const indexes = await tx.execute<{ indexname: string }>(
        sql.raw(`select indexname from pg_indexes
                 where schemaname = '${schemaName}' and tablename = 'posts'`),
      );
      expect(indexes.map((row) => row.indexname)).toContain("posts_status_scheduled_idx");
      const constraints = await tx.execute<{ conname: string }>(
        sql.raw(`select conname from pg_constraint where conrelid = 'posts'::regclass`),
      );
      expect(constraints.map((row) => row.conname)).toEqual(
        expect.arrayContaining([
          "posts_schedule_pair_check",
          "posts_schedule_draft_only_check",
          "posts_published_at_check",
        ]),
      );

      await expectConstraintViolation(
        tx,
        "schedule_pair",
        `update posts set scheduled_at = now() where id = '${legacyId}'`,
        "posts_schedule_pair_check",
      );
      await expectConstraintViolation(
        tx,
        "schedule_draft_only",
        `update posts set status = 'archived', scheduled_at = now(),
          schedule_token = '22222222-2222-4222-8222-222222222222'
          where id = '${legacyId}'`,
        "posts_schedule_draft_only_check",
      );
      await expectConstraintViolation(
        tx,
        "published_at",
        `update posts set status = 'published', published_at = null where id = '${legacyId}'`,
        "posts_published_at_check",
      );

      const migrationSql = migrationStatements("0010_nostalgic_killraven.sql").join("\n");
      expect(migrationSql).not.toMatch(/add\s+value\s+'scheduled'/i);
      expect(migrationSql).not.toMatch(/status\s*=\s*'scheduled'/i);

      await tx.execute(sql.raw("set local search_path to public"));
      await tx.execute(sql.raw(`drop schema "${schemaName}" cascade`));
    });
  });
});

function readMigrationName(index: number): string {
  const prefix = index.toString().padStart(4, "0");
  const fileNames = [
    "0000_concerned_daimon_hellstrom.sql",
    "0001_cool_triathlon.sql",
    "0002_watery_praxagora.sql",
    "0003_user_locale.sql",
    "0004_japanese_locale_foundation.sql",
    "0005_content_i18n_model.sql",
    "0006_whole_blazing_skull.sql",
    "0007_long_mystique.sql",
    "0008_first_speed_demon.sql",
    "0009_modern_absorbing_man.sql",
  ];
  const fileName = fileNames[index];
  if (!fileName?.startsWith(prefix)) throw new Error(`missing migration ${prefix}`);
  return fileName;
}

type TransactionClient = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function expectConstraintViolation(
  tx: TransactionClient,
  _savepoint: string,
  statement: string,
  constraintName: string,
): Promise<void> {
  await tx.execute(
    sql.raw(`
      do $constraint_test$
      declare
        actual_constraint text;
      begin
        begin
          ${statement};
          raise exception 'expected constraint ${constraintName}';
        exception when check_violation then
          get stacked diagnostics actual_constraint = constraint_name;
          if actual_constraint <> '${constraintName}' then
            raise exception 'expected constraint ${constraintName}, got %', actual_constraint;
          end if;
        end;
      end
      $constraint_test$
    `),
  );
}
