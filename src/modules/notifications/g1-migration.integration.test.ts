import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const MIGRATIONS_DIR = path.join(process.cwd(), "src/db/migrations");
const G1_MIGRATION_FILE = "0024_g1_transactional_email_privacy.sql";
const SAFE_EMAIL = "fan@example.test";
const MIGRATION_ERROR = "Email recipient could not be migrated to a safe domain reference";

async function migrationStatements(fileName: string): Promise<string[]> {
  return (await readFile(path.join(MIGRATIONS_DIR, fileName), "utf8"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describeWithDatabase("G1 transactional email privacy migration", () => {
  let sourceUrl: string;
  let admin: ReturnType<typeof postgres>;
  let databaseName: string;
  let db: ReturnType<typeof postgres>;

  beforeEach(async () => {
    sourceUrl = process.env.DATABASE_URL!;
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    databaseName = `olp_g1_email_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`create database "${databaseName}"`);
    const testUrl = new URL(sourceUrl);
    testUrl.pathname = `/${databaseName}`;
    db = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });

    const migrationFiles = (await readdir(MIGRATIONS_DIR))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file < G1_MIGRATION_FILE)
      .sort();
    // The real migration runner executes each file inside one transaction
    // (0024 relies on that for LOCK TABLE); mirror those semantics here.
    for (const fileName of migrationFiles) {
      const statements = await migrationStatements(fileName);
      await db.begin(async (tx) => {
        for (const statement of statements) {
          await tx.unsafe(statement);
        }
      });
    }
  });

  afterAll(async () => {
    if (db) await db.end({ timeout: 5 });
    if (databaseName) await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    if (admin) await admin.end({ timeout: 5 });
  });

  async function runG1Migration(): Promise<void> {
    const statements = await migrationStatements(G1_MIGRATION_FILE);
    await db.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
    });
  }

  async function seedDomainRows() {
    const userId = randomUUID();
    const tierId = randomUUID();
    const activatedMembershipId = randomUUID();
    const revokedMembershipId = randomUUID();
    const activatedRequestId = randomUUID();
    const mismatchMembershipId = randomUUID();
    const mismatchRequestId = randomUUID();
    const revokedRequestId = randomUUID();
    const rejectedRequestId = randomUUID();
    const subscriptionId = randomUUID();
    const activatedEndsAt = "2026-08-12T00:00:00.000Z";
    const revokedEndsAt = "2026-09-12T00:00:00.000Z";
    const rejectedReviewedAt = "2026-07-12T01:02:03.000Z";
    const renewalPeriodEndsAt = "2026-10-12T00:00:00.000Z";

    await db`
      insert into users (id, email, locale)
      values (${userId}, ${SAFE_EMAIL}, 'ja')
    `;
    await db`
      insert into membership_tiers (
        id, name, slug, price_label, level, duration_days
      )
      values (${tierId}, 'Supporter', ${`supporter-${tierId}`}, '$5', 10, 31)
    `;
    await db`
      insert into memberships (
        id, user_id, tier_id, source, starts_at, ends_at, status
      )
      values
        (${activatedMembershipId}, ${userId}, ${tierId}, 'payment_review', '2026-07-12T00:00:00.000Z', ${activatedEndsAt}, 'active'),
        (${mismatchMembershipId}, ${userId}, ${tierId}, 'payment_review', '2026-07-12T00:00:00.000Z', ${activatedEndsAt}, 'active'),
        (${revokedMembershipId}, ${userId}, ${tierId}, 'payment_review', '2026-07-12T00:00:00.000Z', ${revokedEndsAt}, 'revoked')
    `;
    await db`
      insert into payment_requests (
        id, user_id, tier_id, status, amount_label, duration_days, granted_membership_id,
        review_note, reviewed_at
      )
      values
        (${activatedRequestId}, ${userId}, ${tierId}, 'approved', '$5', 31, ${activatedMembershipId}, null, '2026-07-12T00:00:00.000Z'),
        (${mismatchRequestId}, ${userId}, ${tierId}, 'approved', '$5', 31, ${mismatchMembershipId}, null, '2026-07-12T00:00:00.000Z'),
        (${revokedRequestId}, ${userId}, ${tierId}, 'reversed', '$5', 31, ${revokedMembershipId}, null, '2026-07-12T00:00:00.000Z'),
        (${rejectedRequestId}, ${userId}, ${tierId}, 'rejected', '$5', 31, null, 'Proof unclear', ${rejectedReviewedAt})
    `;
    await db`
      insert into subscriptions (
        id, user_id, tier_id, status, provider, current_period_ends_at
      )
      values (${subscriptionId}, ${userId}, ${tierId}, 'active', null, ${renewalPeriodEndsAt})
    `;

    return {
      activatedEndsAt,
      activatedMembershipId,
      activatedRequestId,
      mismatchRequestId,
      rejectedRequestId,
      rejectedReviewedAt,
      renewalPeriodEndsAt,
      revokedMembershipId,
      revokedRequestId,
      subscriptionId,
    };
  }

  it("rewrites safe rows, redacts terminal rows, dead-letters unsafe retryable rows, and removes all raw recipients", async () => {
    const rows = await seedDomainRows();
    const terminalSafeId = randomUUID();
    const terminalUnsafeId = randomUUID();
    const unsafeId = randomUUID();
    const malformedId = randomUUID();
    const loginCodeTaskId = randomUUID();

    await db`
      insert into tasks (id, kind, dedupe_key, payload_json, status)
      values
        (
          ${randomUUID()},
          'email',
          ${`email:membership_activated:${rows.activatedRequestId}`},
          ${db.json({
            template: "membership_activated",
            to: SAFE_EMAIL,
            locale: "ja",
            params: { tierName: "Supporter", endsAt: rows.activatedEndsAt },
          })},
          'pending'
        ),
        (
          ${randomUUID()},
          'email',
          ${`email:membership_revoked:${rows.revokedRequestId}`},
          ${db.json({
            template: "membership_revoked",
            to: SAFE_EMAIL,
            locale: "ja",
            params: { tierName: "Supporter" },
          })},
          'failed'
        ),
        (
          ${randomUUID()},
          'email',
          ${`email:payment_rejected:${rows.rejectedRequestId}:${rows.rejectedReviewedAt}`},
          ${db.json({
            template: "payment_rejected",
            to: SAFE_EMAIL,
            locale: "ja",
            params: { tierName: "Supporter", reviewNote: "Proof unclear" },
          })},
          'processing'
        ),
        (
          ${randomUUID()},
          'email',
          ${`email:renewal_reminder:${rows.subscriptionId}:${rows.renewalPeriodEndsAt}`},
          ${db.json({
            template: "renewal_reminder",
            subscriptionId: rows.subscriptionId,
            periodEndsAt: rows.renewalPeriodEndsAt,
            to: SAFE_EMAIL,
            locale: "ja",
            params: { tierName: "Supporter", endsAt: rows.renewalPeriodEndsAt },
          })},
          'pending'
        ),
        (
          ${terminalSafeId},
          'email',
          ${`email:membership_activated:${randomUUID()}`},
          ${db.json({
            template: "membership_activated",
            to: SAFE_EMAIL,
            locale: "ja",
            params: { tierName: "Supporter", endsAt: rows.activatedEndsAt },
          })},
          'succeeded'
        ),
        (
          ${terminalUnsafeId},
          'email',
          ${`email:membership_activated:${randomUUID()}`},
          ${db.json({
            template: "membership_activated",
            to: "old@example.test",
            locale: "en",
            params: { tierName: "Supporter", endsAt: rows.activatedEndsAt },
          })},
          'succeeded'
        ),
        (
          ${unsafeId},
          'email',
          ${`email:membership_activated:${rows.mismatchRequestId}`},
          ${db.json({
            template: "membership_activated",
            to: "different@example.test",
            locale: "ja",
            params: { tierName: "Supporter", endsAt: rows.activatedEndsAt },
          })},
          'pending'
        ),
        (
          ${malformedId},
          'email',
          ${`email:renewal_reminder:${rows.subscriptionId}:not-a-date`},
          ${db.json({
            template: "renewal_reminder",
            subscriptionId: rows.subscriptionId,
            periodEndsAt: "not-a-date",
            to: SAFE_EMAIL,
            locale: "ja",
            params: { tierName: "Supporter", endsAt: "not-a-date" },
          })},
          'processing'
        ),
        (
          ${loginCodeTaskId},
          'auth.login_code_email',
          ${`login:${randomUUID()}`},
          ${db.json({ version: 1, codeId: randomUUID(), encryptedCode: "ciphertext" })},
          'pending'
        )
    `;

    await runG1Migration();

    const emailTasks = await db<
      {
        id: string;
        dedupe_key: string | null;
        last_error: string | null;
        payload_json: Record<string, unknown>;
        status: string;
      }[]
    >`
      select id, dedupe_key, payload_json, status, last_error
      from tasks
      where kind = 'email'
      order by dedupe_key nulls last, id
    `;

    const activated = emailTasks.find(
      (task) =>
        task.payload_json.template === "membership_activated" &&
        task.id !== terminalSafeId &&
        task.id !== terminalUnsafeId &&
        task.id !== unsafeId,
    );
    expect(activated?.payload_json).toMatchObject({
      version: 2,
      template: "membership_activated",
      paymentRequestId: rows.activatedRequestId,
      membershipId: rows.activatedMembershipId,
    });

    const revoked = emailTasks.find((task) => task.payload_json.template === "membership_revoked");
    expect(revoked?.payload_json).toMatchObject({
      version: 2,
      template: "membership_revoked",
      paymentRequestId: rows.revokedRequestId,
      membershipId: rows.revokedMembershipId,
    });

    const rejected = emailTasks.find((task) => task.payload_json.template === "payment_rejected");
    expect(rejected?.payload_json).toMatchObject({
      version: 2,
      template: "payment_rejected",
      paymentRequestId: rows.rejectedRequestId,
      reviewedAt: rows.rejectedReviewedAt,
    });

    const renewal = emailTasks.find(
      (task) =>
        task.payload_json.template === "renewal_reminder" &&
        task.payload_json.version === 2 &&
        task.id !== malformedId,
    );
    expect(renewal?.payload_json).toMatchObject({
      version: 2,
      template: "renewal_reminder",
      subscriptionId: rows.subscriptionId,
      periodEndsAt: rows.renewalPeriodEndsAt,
    });

    const terminalSafe = emailTasks.find((task) => task.id === terminalSafeId);
    expect(terminalSafe).toMatchObject({
      status: "succeeded",
      payload_json: { version: 1, template: "membership_activated", recipientRedacted: true },
    });
    expect(terminalSafe?.payload_json).not.toHaveProperty("paymentRequestId");
    expect(terminalSafe?.payload_json).not.toHaveProperty("membershipId");

    const terminalUnsafe = emailTasks.find((task) => task.id === terminalUnsafeId);
    expect(terminalUnsafe).toMatchObject({
      status: "succeeded",
      payload_json: { version: 1, template: "membership_activated", recipientRedacted: true },
    });

    for (const id of [unsafeId, malformedId]) {
      const task = emailTasks.find((candidate) => candidate.id === id);
      expect(task).toMatchObject({
        status: "dead",
        last_error: MIGRATION_ERROR,
        payload_json: { recipientRedacted: true },
      });
    }

    const [remainingRaw] = await db<{ count: string }[]>`
      select count(*)::text as count
      from tasks
      where kind = 'email'
        and payload_json ? 'to'
    `;
    expect(remainingRaw?.count).toBe("0");

    const [loginCode] = await db<{ payload_json: Record<string, unknown> }[]>`
      select payload_json
      from tasks
      where id = ${loginCodeTaskId}
    `;
    expect(loginCode?.payload_json).toMatchObject({
      version: 1,
      codeId: expect.any(String),
      encryptedCode: "ciphertext",
    });
    expect(loginCode?.payload_json).not.toHaveProperty("to");
  });
});
