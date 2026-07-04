import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const MIGRATIONS_DIR = path.join(process.cwd(), "src/db/migrations");

async function migrationStatements(fileName: string): Promise<string[]> {
  return (await readFile(path.join(MIGRATIONS_DIR, fileName), "utf8"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function latestBaselineMigrationWhen(): Promise<number> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  return Math.max(
    ...journal.entries
      .filter((entry) => entry.tag.slice(0, 4) <= "0019")
      .map((entry) => entry.when),
  );
}

describeWithDatabase("file reference integrity migration", () => {
  const sourceUrl = process.env.DATABASE_URL!;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  let databaseName: string;
  let databaseUrl: string;
  let db: ReturnType<typeof postgres>;

  beforeEach(async () => {
    databaseName = `olp_file_integrity_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`create database "${databaseName}"`);
    const testUrl = new URL(sourceUrl);
    testUrl.pathname = `/${databaseName}`;
    databaseUrl = testUrl.toString();
    db = postgres(databaseUrl, { max: 1, onnotice: () => {} });

    const migrationFiles = (await readdir(MIGRATIONS_DIR))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file.slice(0, 4) <= "0019")
      .sort();
    for (const fileName of migrationFiles) {
      for (const statement of await migrationStatements(fileName)) {
        await db.unsafe(statement);
      }
    }

    // Record a drizzle migrations bookkeeping row matching the 0019 baseline so
    // that a real `drizzle-orm` migrate() run (e.g. the actual scripts/migrate.mjs
    // process, used by the lock-race regression test below) recognizes 0001-0019
    // as already applied and only attempts 0020, instead of re-running everything
    // against a database that already has that schema.
    await db.unsafe(`create schema if not exists drizzle`);
    await db.unsafe(
      `create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
    );
    await db`
      insert into drizzle.__drizzle_migrations ("hash", "created_at")
      values ('test-harness-0019-baseline', ${await latestBaselineMigrationWhen()})
    `;
  });

  afterEach(async () => {
    if (db) await db.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  });

  afterAll(async () => {
    await admin.end({ timeout: 5 });
  });

  async function migrate0020(): Promise<void> {
    const statements = await migrationStatements("0020_file_reference_integrity.sql");
    await db.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
    });
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

  it("aborts instead of silently keeping a reference written while the migration's lock is queued", async () => {
    const fileId = randomUUID();
    const postId = randomUUID();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose,
        quarantined_at, quarantine_reason
      ) values (
        ${fileId}, 'local', ${`payment_proof/${fileId}`}, 'proof.png',
        'image/png', 10, 'payment_proof', now(), 'r6-regression'
      )
    `;
    await db`
      insert into posts (id, title, slug, visibility, status)
      values (${postId}, 'r6 regression post', 'r6-regression-post', 'public', 'draft')
    `;

    // Both the blocker's lock and the injector's write must be acquired BEFORE the
    // migrator ever starts. PostgreSQL's lock queue is fair: once the migrator's
    // AccessExclusiveLock request is queued, any later conflicting request (even a
    // weaker one) queues behind it too. So the attack only works if the injector's
    // RowExclusiveLock (from its INSERT) is already granted before the migrator's
    // request exists at all.
    const blocker = await postgres(databaseUrl, {
      max: 1,
      connection: { application_name: "r6_regression_blocker" },
    }).reserve();
    await blocker`BEGIN`;
    await blocker`LOCK TABLE post_files IN ROW SHARE MODE`;

    const injector = await postgres(databaseUrl, {
      max: 1,
      connection: { application_name: "r6_regression_injector" },
    }).reserve();
    await injector`BEGIN`;
    await injector`
      insert into post_files (post_id, file_id, kind, sort_order)
      values (${postId}, ${fileId}, 'inline', 0)
    `;

    const migrator = spawn("node", ["scripts/migrate.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: `${databaseUrl}?application_name=r6_regression_migrator`,
        MIGRATE_MAX_ATTEMPTS: "1",
      },
    });
    let migratorStderr = "";
    migrator.stderr.on("data", (chunk) => (migratorStderr += chunk.toString()));

    // The migrator's single LOCK TABLE statement locks six tables in the order
    // listed (files, posts, payment_methods, payment_requests, post_files,
    // site_settings); it only actually contends with the blocker once it reaches
    // post_files, but check for any ungranted lock rather than pinning to one
    // relation.
    let migratorBlocked = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const waiting = await db`
        select 1
          from pg_stat_activity a
          join pg_locks l on l.pid = a.pid
         where a.application_name = 'r6_regression_migrator' and l.granted = false
      `;
      if (waiting.length > 0) {
        migratorBlocked = true;
        break;
      }
      await sleep(50);
    }
    expect(migratorBlocked).toBe(true);

    // The violating write lands now, while the migrator is still queued.
    await injector`COMMIT`;
    await injector.release();

    await blocker`COMMIT`;
    await blocker.release();

    const exitCode = await new Promise<number | null>((resolve) => migrator.on("close", resolve));
    expect(exitCode).not.toBe(0);
    expect(migratorStderr).toMatch(/post_files\.file_id/);

    // Migration must not have partially applied: the 0020-only constraint is absent.
    await expect(db`
      select 1 from pg_constraint where conname = 'payment_methods_qr_file_id_files_id_fk'
    `).resolves.toHaveLength(0);

    // After remediation (removing the bad reference), a clean rerun must succeed.
    await db`delete from post_files where post_id = ${postId} and file_id = ${fileId}`;
    await migrate0020();
    await expect(db`
      select 1 from pg_constraint where conname = 'payment_methods_qr_file_id_files_id_fk'
    `).resolves.toHaveLength(1);
  }, 20_000);

  it("aborts instead of silently accepting a file quarantined while the migration's lock is queued", async () => {
    const fileId = randomUUID();
    const postId = randomUUID();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose
      ) values (
        ${fileId}, 'local', ${`content_image/${fileId}`}, 'inline.png',
        'image/png', 10, 'content_image'
      )
    `;
    await db`
      insert into posts (id, title, slug, visibility, status)
      values (${postId}, 'r6b regression post', 'r6b-regression-post', 'public', 'draft')
    `;
    await db`
      insert into post_files (post_id, file_id, kind, sort_order)
      values (${postId}, ${fileId}, 'inline', 0)
    `;

    // Same timing requirement as the reference-injection case above: the
    // quarantine write must be granted before the migrator's LOCK TABLE request
    // exists, or it queues behind the migrator instead of landing first.
    const blocker = await postgres(databaseUrl, {
      max: 1,
      connection: { application_name: "r6b_regression_blocker" },
    }).reserve();
    await blocker`BEGIN`;
    await blocker`LOCK TABLE files IN ROW SHARE MODE`;

    const injector = await postgres(databaseUrl, {
      max: 1,
      connection: { application_name: "r6b_regression_injector" },
    }).reserve();
    await injector`BEGIN`;
    await injector`
      update files set quarantined_at = now(), quarantine_reason = 'r6b-regression'
       where id = ${fileId}
    `;

    const migrator = spawn("node", ["scripts/migrate.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: `${databaseUrl}?application_name=r6b_regression_migrator`,
        MIGRATE_MAX_ATTEMPTS: "1",
      },
    });
    let migratorStderr = "";
    migrator.stderr.on("data", (chunk) => (migratorStderr += chunk.toString()));

    let migratorBlocked = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const waiting = await db`
        select 1
          from pg_stat_activity a
          join pg_locks l on l.pid = a.pid
         where a.application_name = 'r6b_regression_migrator' and l.granted = false
      `;
      if (waiting.length > 0) {
        migratorBlocked = true;
        break;
      }
      await sleep(50);
    }
    expect(migratorBlocked).toBe(true);

    // The quarantine lands now, while the migrator is still queued on `files`.
    await injector`COMMIT`;
    await injector.release();

    await blocker`COMMIT`;
    await blocker.release();

    const exitCode = await new Promise<number | null>((resolve) => migrator.on("close", resolve));
    expect(exitCode).not.toBe(0);
    expect(migratorStderr).toMatch(/post_files\.file_id/);

    await expect(db`
      select 1 from pg_constraint where conname = 'payment_methods_qr_file_id_files_id_fk'
    `).resolves.toHaveLength(0);

    // After remediation (lifting the quarantine), a clean rerun must succeed.
    await db`update files set quarantined_at = null, quarantine_reason = null where id = ${fileId}`;
    await migrate0020();
    await expect(db`
      select 1 from pg_constraint where conname = 'payment_methods_qr_file_id_files_id_fk'
    `).resolves.toHaveLength(1);
  }, 20_000);
});
