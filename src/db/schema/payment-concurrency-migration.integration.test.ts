import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runRemediation(databaseUrl: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/dedupe-pending-payments.mjs", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describeWithDatabase("pending payment migration and remediation", () => {
  const sourceUrl = process.env.DATABASE_URL!;
  const databaseName = `olp_s3_migration_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  let db: ReturnType<typeof postgres>;
  let migrationStatements: string[];

  beforeAll(async () => {
    await admin.unsafe(`create database "${databaseName}"`);
    db = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
    await db.unsafe(`
      create table users (
        id uuid primary key,
        email text unique not null,
        role text not null default 'member'
      );
      create table payment_requests (
        id uuid primary key,
        user_id uuid not null,
        tier_id uuid not null,
        status text not null,
        flow text not null default 'manual',
        provider text,
        review_note text,
        reviewed_by uuid,
        reviewed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table audit_events (
        id uuid primary key default gen_random_uuid(),
        entity_type text not null,
        entity_id uuid not null,
        action text not null,
        actor_type text not null,
        actor_id uuid,
        reason text,
        before_json jsonb,
        after_json jsonb,
        correlation_id uuid not null,
        causation_id uuid,
        created_at timestamptz not null default now()
      );
    `);
    const migration = await readFile(
      path.join(process.cwd(), "src/db/migrations/0014_red_jazinda.sql"),
      "utf8",
    );
    migrationStatements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
  });

  afterAll(async () => {
    if (db) await db.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await admin.end({ timeout: 5 });
  });

  it("reports duplicates, keeps dry-run read-only, audits explicit remediation, and then migrates", async () => {
    const userId = randomUUID();
    const tierId = randomUUID();
    const keepId = randomUUID();
    const duplicateIds = [randomUUID(), randomUUID()];
    const adminActorId = randomUUID();
    const memberActorId = randomUUID();
    const missingActorId = randomUUID();
    await db`
      insert into users (id, email, role)
      values
        (${adminActorId}, ${`admin-${adminActorId}@example.test`}, 'admin'),
        (${memberActorId}, ${`member-${memberActorId}@example.test`}, 'member')
    `;
    for (const id of [keepId, ...duplicateIds]) {
      await db`
        insert into payment_requests (id, user_id, tier_id, status)
        values (${id}, ${userId}, ${tierId}, 'pending_review')
      `;
    }

    await expect(db.unsafe(migrationStatements[0]!)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining(`user_id=${userId} tier_id=${tierId} count=3`),
      }),
    );

    const report = await runRemediation(testUrl.toString(), []);
    expect(report.code).toBe(2);
    expect(report.stdout).toContain(userId);
    expect(report.stdout).toContain(tierId);
    expect(report.stdout).toContain('"count": 3');

    const dryRun = await runRemediation(testUrl.toString(), [
      "--keep",
      keepId,
      "--resolve",
      "cancelled",
      "--dry-run",
    ]);
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout).toContain('"mode": "dry-run"');
    expect(dryRun.stdout).toContain(duplicateIds[0]!);
    const beforeApply = await db`
      select id, status from payment_requests order by id
    `;
    expect(beforeApply.every((row) => row.status === "pending_review")).toBe(true);

    for (const invalidActorId of [missingActorId, memberActorId]) {
      const rejected = await runRemediation(testUrl.toString(), [
        "--keep",
        keepId,
        "--resolve",
        "cancelled",
        "--apply",
        "--actor-id",
        invalidActorId,
        "--reason",
        "Reviewed duplicate pending requests",
      ]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("Actor must reference an existing admin user");

      const unchangedRows = await db`
        select id, status, reviewed_by from payment_requests order by id
      `;
      expect(unchangedRows.every((row) => row.status === "pending_review")).toBe(true);
      expect(unchangedRows.every((row) => row.reviewed_by === null)).toBe(true);
      await expect(db`select count(*)::integer as count from audit_events`).resolves.toMatchObject([
        { count: 0 },
      ]);
    }

    const applied = await runRemediation(testUrl.toString(), [
      "--keep",
      keepId,
      "--resolve",
      "cancelled",
      "--apply",
      "--actor-id",
      adminActorId,
      "--reason",
      "Reviewed duplicate pending requests",
    ]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain('"mode": "apply"');
    for (const duplicateId of duplicateIds) {
      expect(applied.stdout).toContain(duplicateId);
    }

    const rows = await db`
      select id, status from payment_requests order by id
    `;
    expect(rows.find((row) => row.id === keepId)?.status).toBe("pending_review");
    expect(
      rows
        .filter((row) => duplicateIds.includes(row.id))
        .every((row) => row.status === "cancelled"),
    ).toBe(true);
    const audits = await db`
      select entity_id, action, actor_id, before_json, after_json
        from audit_events
       order by entity_id
    `;
    expect(audits).toHaveLength(2);
    expect(audits.every((event) => event.action === "dedupe_pending_payment")).toBe(true);
    expect(audits.every((event) => event.actor_id === adminActorId)).toBe(true);
    expect(audits.every((event) => event.after_json.keptRequestId === keepId)).toBe(true);

    const repeated = await runRemediation(testUrl.toString(), [
      "--keep",
      keepId,
      "--resolve",
      "cancelled",
      "--apply",
      "--actor-id",
      adminActorId,
      "--reason",
      "Reviewed duplicate pending requests",
    ]);
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toContain('"changed": []');
    await expect(db`select count(*)::integer as count from audit_events`).resolves.toMatchObject([
      { count: 2 },
    ]);

    for (const statement of migrationStatements) {
      await db.unsafe(statement);
    }
    const [index] = await db`
      select indexname
        from pg_indexes
       where schemaname = 'public'
         and indexname = 'payment_requests_pending_user_tier_unique'
    `;
    expect(index?.indexname).toBe("payment_requests_pending_user_tier_unique");
    await expect(
      db`
        insert into payment_requests (id, user_id, tier_id, status)
        values (${randomUUID()}, ${userId}, ${tierId}, 'pending_payment')
      `,
    ).rejects.toThrow();
  });
});
