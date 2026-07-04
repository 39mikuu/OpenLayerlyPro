import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

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
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  let databaseName: string;
  let db: ReturnType<typeof postgres>;

  beforeEach(async () => {
    databaseName = `olp_file_integrity_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`create database "${databaseName}"`);
    const testUrl = new URL(sourceUrl);
    testUrl.pathname = `/${databaseName}`;
    db = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });

    const migrationFiles = (await readdir(MIGRATIONS_DIR))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file.slice(0, 4) <= "0019")
      .sort();
    for (const fileName of migrationFiles) {
      for (const statement of await migrationStatements(fileName)) {
        await db.unsafe(statement);
      }
    }
  });

  afterEach(async () => {
    if (db) await db.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  });

  afterAll(async () => {
    await admin.end({ timeout: 5 });
  });

  async function migrate0020(): Promise<void> {
    for (const statement of await migrationStatements("0020_file_reference_integrity.sql")) {
      await db.unsafe(statement);
    }
  }

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

    await migrate0020();

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

  it("removes only an invalid legacy site file setting and preserves valid values", async () => {
    const invalidFileId = randomUUID();
    const validAvatarId = randomUUID();
    const validIconId = randomUUID();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose
      ) values
        (
          ${invalidFileId}, 'local', ${`content_image/${invalidFileId}`}, 'invalid.png',
          'image/png', 10, 'content_image'
        ),
        (
          ${validAvatarId}, 'local', ${`artist_avatar/${validAvatarId}`}, 'avatar.png',
          'image/png', 10, 'artist_avatar'
        ),
        (
          ${validIconId}, 'local', ${`artist_avatar/${validIconId}`}, 'icon.png',
          'image/png', 10, 'artist_avatar'
        )
    `;
    await db`
      insert into site_settings (key, value_json)
      values
        ('artist_avatar_file_id', ${db.json(validAvatarId)}),
        ('site_logo_file_id', ${db.json(invalidFileId)}),
        ('site_icon_file_id', ${db.json(validIconId)})
    `;

    await migrate0020();

    await expect(db`
      select key, value_json
        from site_settings
       where key in ('artist_avatar_file_id', 'site_logo_file_id', 'site_icon_file_id')
       order by key
    `).resolves.toEqual([
      { key: "artist_avatar_file_id", value_json: validAvatarId },
      { key: "site_icon_file_id", value_json: validIconId },
    ]);
  });

  it("blocks deletion when a site setting stores an uppercase file UUID", async () => {
    const fileId = "A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6";
    await migrate0020();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose
      ) values (
        ${fileId}, 'local', ${`artist_avatar/${fileId}`}, 'logo.png',
        'image/png', 10, 'artist_avatar'
      )
    `;
    await db`
      insert into site_settings (key, value_json)
      values ('site_logo_file_id', ${db.json(fileId)})
    `;

    await expect(db`delete from files where id = ${fileId}`).rejects.toMatchObject({
      code: "23503",
    });
    await expect(db`select id from files where id = ${fileId}`).resolves.toHaveLength(1);
  });
});
