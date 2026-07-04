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

  it("aborts on legacy post cover files with an invalid purpose and preserves rows", async () => {
    const fileId = randomUUID();
    const postId = randomUUID();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose
      ) values (
        ${fileId}, 'local', ${`payment_proof/${fileId}`}, 'proof.png',
        'image/png', 10, 'payment_proof'
      )
    `;
    await db`
      insert into posts (id, title, slug, cover_file_id, visibility, status)
      values (
        ${postId}, 'legacy invalid cover post', 'legacy-invalid-cover-post',
        ${fileId}, 'public', 'draft'
      )
    `;

    await expect(migrate0020()).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("posts.cover_file_id"),
    });

    await expect(db`
      select id, cover_file_id
        from posts
       where id = ${postId}
    `).resolves.toEqual([{ id: postId, cover_file_id: fileId }]);
    await expect(db`
      select 1 from pg_constraint where conname = 'posts_cover_file_id_files_id_fk'
    `).resolves.toHaveLength(0);
  });

  it("aborts on legacy payment method QR files with an invalid purpose and preserves rows", async () => {
    const fileId = randomUUID();
    const methodId = randomUUID();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose
      ) values (
        ${fileId}, 'local', ${`content_image/${fileId}`}, 'qr.png',
        'image/png', 10, 'content_image'
      )
    `;
    await db`
      insert into payment_methods (id, name, qr_file_id)
      values (${methodId}, 'Legacy invalid QR method', ${fileId})
    `;

    await expect(migrate0020()).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("payment_methods.qr_file_id"),
    });

    await expect(db`
      select id, qr_file_id
        from payment_methods
       where id = ${methodId}
    `).resolves.toEqual([{ id: methodId, qr_file_id: fileId }]);
    await expect(db`
      select 1 from pg_constraint where conname = 'payment_methods_qr_file_id_files_id_fk'
    `).resolves.toHaveLength(0);
  });

  it("aborts on a legacy payment request proof file with an invalid purpose and preserves rows", async () => {
    const fileId = randomUUID();
    const userId = randomUUID();
    const tierId = randomUUID();
    const requestId = randomUUID();
    await db`
      insert into users (id, email, role)
      values (${userId}, 'r5-proof-invalid-purpose@example.com', 'member')
    `;
    await db`
      insert into membership_tiers (id, name, slug, price_label, level)
      values (${tierId}, 'R5 proof purpose tier', 'r5-proof-purpose-tier', '$1', 1)
    `;
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose, created_by
      ) values (
        ${fileId}, 'local', ${`content_image/${fileId}`}, 'proof-invalid-purpose.png',
        'image/png', 10, 'content_image', ${userId}
      )
    `;
    await db`
      insert into payment_requests (id, user_id, tier_id, status, amount_label, duration_days, proof_file_id)
      values (${requestId}, ${userId}, ${tierId}, 'rejected', '$1', 31, ${fileId})
    `;

    await expect(migrate0020()).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("payment_requests.proof_file_id"),
    });

    await expect(db`
      select id, user_id, proof_file_id
        from payment_requests
       where id = ${requestId}
    `).resolves.toEqual([{ id: requestId, user_id: userId, proof_file_id: fileId }]);
    await expect(db`
      select 1 from pg_constraint where conname = 'payment_requests_proof_file_id_files_id_fk'
    `).resolves.toHaveLength(0);
  });

  it("aborts on a legacy payment request proof file owned by someone else and preserves rows", async () => {
    const fileId = randomUUID();
    const requesterId = randomUUID();
    const proofOwnerId = randomUUID();
    const tierId = randomUUID();
    const requestId = randomUUID();
    await db`
      insert into users (id, email, role)
      values
        (${requesterId}, 'r5-proof-owner-requester@example.com', 'member'),
        (${proofOwnerId}, 'r5-proof-owner-actual@example.com', 'member')
    `;
    await db`
      insert into membership_tiers (id, name, slug, price_label, level)
      values (${tierId}, 'R5 proof owner tier', 'r5-proof-owner-tier', '$1', 1)
    `;
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose, created_by
      ) values (
        ${fileId}, 'local', ${`payment_proof/${fileId}`}, 'proof-owner-mismatch.png',
        'image/png', 10, 'payment_proof', ${proofOwnerId}
      )
    `;
    await db`
      insert into payment_requests (id, user_id, tier_id, status, amount_label, duration_days, proof_file_id)
      values (${requestId}, ${requesterId}, ${tierId}, 'rejected', '$1', 31, ${fileId})
    `;

    await expect(migrate0020()).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("payment_requests.proof_file_id"),
    });

    await expect(db`
      select id, user_id, proof_file_id
        from payment_requests
       where id = ${requestId}
    `).resolves.toEqual([{ id: requestId, user_id: requesterId, proof_file_id: fileId }]);
    await expect(db`
      select 1 from pg_constraint where conname = 'payment_requests_proof_file_id_files_id_fk'
    `).resolves.toHaveLength(0);
  });

  it("aborts on legacy post file rows with invalid kind and purpose combinations and preserves rows", async () => {
    const fileId = randomUUID();
    const postId = randomUUID();
    const postFileId = randomUUID();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose
      ) values (
        ${fileId}, 'local', ${`content_image/${fileId}`}, 'attachment.png',
        'image/png', 10, 'content_image'
      )
    `;
    await db`
      insert into posts (id, title, slug, visibility, status)
      values (${postId}, 'legacy invalid post file', 'legacy-invalid-post-file', 'public', 'draft')
    `;
    await db`
      insert into post_files (id, post_id, file_id, kind, sort_order)
      values (${postFileId}, ${postId}, ${fileId}, 'attachment', 0)
    `;

    await expect(migrate0020()).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("post_files.file_id"),
    });

    await expect(db`
      select id, post_id, file_id, kind, sort_order
        from post_files
       where id = ${postFileId}
    `).resolves.toEqual([
      {
        id: postFileId,
        post_id: postId,
        file_id: fileId,
        kind: "attachment",
        sort_order: 0,
      },
    ]);
    await expect(db`
      select 1 from pg_constraint where conname = 'payment_methods_qr_file_id_files_id_fk'
    `).resolves.toHaveLength(0);
  });

  it("aborts on legacy site file settings with an invalid purpose and preserves rows", async () => {
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

    await expect(migrate0020()).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("site_settings key="),
    });

    await expect(db`
      select key, value_json
        from site_settings
       where key in ('artist_avatar_file_id', 'site_logo_file_id', 'site_icon_file_id')
       order by key
    `).resolves.toEqual([
      { key: "artist_avatar_file_id", value_json: fileId },
      { key: "site_icon_file_id", value_json: fileId },
      { key: "site_logo_file_id", value_json: fileId },
    ]);
    await expect(db`
      select exists (
        select 1
          from information_schema.triggers
         where trigger_name = 'site_settings_file_reference_lock'
      ) as installed
    `).resolves.toMatchObject([{ installed: false }]);
  });

  it("preserves valid legacy site file settings and completes 0020", async () => {
    const validAvatarId = randomUUID();
    const validLogoId = randomUUID();
    const validIconId = randomUUID();
    await db`
      insert into files (
        id, storage_driver, object_key, original_name, mime_type, size_bytes, purpose
      ) values
        (
          ${validAvatarId}, 'local', ${`artist_avatar/${validAvatarId}`}, 'avatar.png',
          'image/png', 10, 'artist_avatar'
        ),
        (
          ${validLogoId}, 'local', ${`artist_avatar/${validLogoId}`}, 'logo.png',
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
        ('site_logo_file_id', ${db.json(validLogoId)}),
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
      { key: "site_logo_file_id", value_json: validLogoId },
    ]);
    await expect(db`
      select exists (
        select 1
          from information_schema.triggers
         where trigger_name = 'site_settings_file_reference_lock'
      ) as installed
    `).resolves.toMatchObject([{ installed: true }]);
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

  it("aborts instead of silently keeping a reference held before a retry", async () => {
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

    // The violating write is committed before the migrator can take the
    // migration-wide NOWAIT lock. A single-attempt migrator must fail loudly
    // during preflight instead of partially installing 0020.
    const injector = await postgres(databaseUrl, {
      max: 1,
      connection: { application_name: "r6_regression_injector" },
    }).reserve();
    await injector`BEGIN`;
    await injector`
      insert into post_files (post_id, file_id, kind, sort_order)
      values (${postId}, ${fileId}, 'inline', 0)
    `;
    await injector`COMMIT`;
    await injector.release();

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

  it("aborts instead of silently accepting a file quarantined before a retry", async () => {
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

    // The quarantine is committed before the migrator can take the
    // migration-wide NOWAIT lock. A single-attempt migrator must fail loudly
    // during preflight instead of partially installing 0020.
    const injector = await postgres(databaseUrl, {
      max: 1,
      connection: { application_name: "r6b_regression_injector" },
    }).reserve();
    await injector`BEGIN`;
    await injector`
      update files set quarantined_at = now(), quarantine_reason = 'r6b-regression'
       where id = ${fileId}
    `;
    await injector`COMMIT`;
    await injector.release();

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

  it("fails immediately with NOWAIT while an application transaction holds a conflicting lock, then succeeds after retry", async () => {
    const blocker = await postgres(databaseUrl, {
      max: 1,
      connection: { application_name: "nowait_lock_blocker" },
    }).reserve();
    let blockerReleased = false;
    await blocker`BEGIN`;
    await blocker`LOCK TABLE posts IN ROW SHARE MODE`;

    try {
      const blockedMigrator = spawn("node", ["scripts/migrate.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `${databaseUrl}?application_name=nowait_lock_migrator_once`,
          MIGRATE_MAX_ATTEMPTS: "1",
        },
      });
      let blockedStdout = "";
      let blockedStderr = "";
      blockedMigrator.stdout.on("data", (chunk) => (blockedStdout += chunk.toString()));
      blockedMigrator.stderr.on("data", (chunk) => (blockedStderr += chunk.toString()));

      const blockedExitCode = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          blockedMigrator.kill("SIGKILL");
          reject(new Error("NOWAIT migrator did not exit promptly"));
        }, 1_500);
        blockedMigrator.on("close", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      expect(blockedExitCode).not.toBe(0);
      expect(`${blockedStdout}\n${blockedStderr}`).toMatch(
        /could not obtain lock|lock_not_available/i,
      );

      await expect(db`
        select 1 from pg_constraint where conname = 'payment_methods_qr_file_id_files_id_fk'
      `).resolves.toHaveLength(0);

      const retryingMigrator = spawn("node", ["scripts/migrate.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `${databaseUrl}?application_name=nowait_lock_migrator_retry`,
          MIGRATE_MAX_ATTEMPTS: "3",
        },
      });
      let retryStdout = "";
      let retryStderr = "";
      retryingMigrator.stdout.on("data", (chunk) => (retryStdout += chunk.toString()));
      retryingMigrator.stderr.on("data", (chunk) => (retryStderr += chunk.toString()));

      await sleep(500);
      await blocker`COMMIT`;
      await blocker.release();
      blockerReleased = true;

      const retryExitCode = await new Promise<number | null>((resolve) =>
        retryingMigrator.on("close", resolve),
      );
      expect(retryExitCode).toBe(0);
      expect(retryStdout).toMatch(/数据库暂不可用/);
      expect(retryStdout).toMatch(/数据库迁移完成/);
      expect(retryStderr).not.toMatch(/数据库迁移失败|could not obtain lock/i);

      await expect(db`
        select 1 from pg_constraint where conname = 'payment_methods_qr_file_id_files_id_fk'
      `).resolves.toHaveLength(1);
    } finally {
      if (!blockerReleased) {
        await blocker.release();
      }
    }
  }, 15_000);
});
