import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const MIGRATIONS_DIR = path.join(process.cwd(), "src/db/migrations");

async function migrationStatements(fileName: string): Promise<string[]> {
  return (await readFile(path.join(MIGRATIONS_DIR, fileName), "utf8"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describeWithDatabase("file reference integrity migration", () => {
  const sourceUrl = process.env.DATABASE_URL!;
  const databaseName = `olp_file_integrity_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  let db: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await admin.unsafe(`create database "${databaseName}"`);
    db = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });

    const migrationFiles = (await import("node:fs/promises"))
      .readdir(MIGRATIONS_DIR)
      .then((files) =>
        files.filter((file) => /^\d{4}_.+\.sql$/.test(file) && file.slice(0, 4) <= "0019").sort(),
      );
    for (const fileName of await migrationFiles) {
      for (const statement of await migrationStatements(fileName)) {
        await db.unsafe(statement);
      }
    }
  });

  afterAll(async () => {
    if (db) await db.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin.end({ timeout: 5 });
  });

  it("removes every legacy site file setting with an invalid purpose and completes 0020", async () => {
    const fileId = randomUUID();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose
      ) values (
        ${fileId}, 'local', ${`content_image/${fileId}`}, 'legacy.png',
        'image/png', 10, 'content_image'
      )
    `;
    await db`
      insert into site_settings (key, value_json)
      values
        ('artist_avatar_file_id', ${db.json(fileId)}),
        ('site_logo_file_id', ${db.json(fileId)}),
        ('site_icon_file_id', ${db.json(fileId)})
    `;

    for (const statement of await migrationStatements("0020_file_reference_integrity.sql")) {
      await db.unsafe(statement);
    }

    await expect(db`
      select key
        from site_settings
       where key in ('artist_avatar_file_id', 'site_logo_file_id', 'site_icon_file_id')
    `).resolves.toHaveLength(0);
    await expect(db`
      select exists (
        select 1
          from information_schema.triggers
         where trigger_name = 'site_settings_file_reference_lock'
      ) as installed
    `).resolves.toMatchObject([{ installed: true }]);
  });
});
