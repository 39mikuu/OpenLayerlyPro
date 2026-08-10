import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmtpConfig: vi.fn(),
  sendMagicLinkEmail: vi.fn(),
  sendMagicLinkEmailWithDeadline: vi.fn(),
}));

vi.mock("@/modules/config", () => ({
  getSmtpConfig: mocks.getSmtpConfig,
}));
vi.mock("@/modules/mail", () => ({
  sendMagicLinkEmail: mocks.sendMagicLinkEmail,
  sendMagicLinkEmailWithDeadline: mocks.sendMagicLinkEmailWithDeadline,
}));
vi.mock("@/modules/security/magic-link-key", () => {
  const keyring = {
    current: { keyId: "v2-current", secret: "v2-current-secret-32-bytes-long!!!!" },
    previous: { keyId: "v2-previous", secret: "v2-previous-secret-32-bytes-long!!!" },
  };
  return {
    tryGetMagicLinkKeys: () => keyring,
    getMagicLinkKeys: () => keyring,
    resetMagicLinkKeyCacheForTests: () => undefined,
  };
});

import { getDb } from "@/db";
import { magicLinkMintLedger, magicLinkRequests, magicLinkTokens, tasks, users } from "@/db/schema";
import { __resetEnvForTests } from "@/lib/env";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { MailDeliveryError } from "@/modules/mail/delivery";
import { claimOneTaskForClass, markTaskFailed, markTaskSucceeded } from "@/modules/tasks";
import { runTaskHandler } from "@/modules/tasks/handlers";

import * as exactBase80dbaa from "./fixtures/magic-link-exact-base-80dbaa";
import {
  consumeMagicLinkToken,
  deliverMagicLinkEmailTask,
  generateMagicLinkToken,
  type MagicLinkDeliveryV2TaskPayload,
  requestMagicLink,
  verifyMagicLinkToken,
} from "./magic-link";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const previousGate = process.env.MAGIC_LINK_INTAKE_ENABLED;

async function expectPostgresCause(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const cause =
      error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    const message =
      cause && typeof cause === "object" && "message" in cause
        ? (cause as { message?: unknown }).message
        : undefined;
    expect(typeof message === "string" ? message : "").toMatch(pattern);
    return;
  }
  throw new Error("Expected PostgreSQL to reject the query");
}

describeWithDatabase("Issue #184 Magic Link protocol v2", () => {
  const db = getDb();

  beforeEach(async () => {
    process.env.MAGIC_LINK_INTAKE_ENABLED = "true";
    __resetEnvForTests();
    __resetRateLimitForTests();
    vi.clearAllMocks();
    mocks.getSmtpConfig.mockResolvedValue({
      configured: true,
      host: "smtp.example.test",
      port: 587,
      secure: false,
      from: "noreply@example.test",
    });
    mocks.sendMagicLinkEmail.mockResolvedValue(undefined);
    mocks.sendMagicLinkEmailWithDeadline.mockResolvedValue(undefined);
    await resetDatabase(db);
  });

  afterAll(async () => {
    if (previousGate === undefined) delete process.env.MAGIC_LINK_INTAKE_ENABLED;
    else process.env.MAGIC_LINK_INTAKE_ENABLED = previousGate;
    __resetEnvForTests();
  });

  async function claimAndRun(queueClass: "auth_intake" | "auth_delivery_v2") {
    const task = await claimOneTaskForClass(queueClass);
    expect(task).not.toBeNull();
    const result = await runTaskHandler(task!);
    await expect(markTaskSucceeded(task!.id, task!.lockedBy!, result.note)).resolves.toBe(true);
    return task!;
  }

  async function createClaimedIntake(email: string) {
    await requestMagicLink(email, { ip: "198.51.100.30" });
    const intake = await claimOneTaskForClass("auth_intake");
    expect(intake).not.toBeNull();
    return intake!;
  }

  async function createClaimedV2Delivery(email: string) {
    await requestMagicLink(email, { ip: "198.51.100.31" });
    await claimAndRun("auth_intake");
    const delivery = await claimOneTaskForClass("auth_delivery_v2");
    expect(delivery).not.toBeNull();
    return {
      task: delivery!,
      payload: delivery!.payloadJson as MagicLinkDeliveryV2TaskPayload,
    };
  }

  async function expectRequestHasNoCommittedMint(email: string) {
    const [request] = await db
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.email, email));
    expect(request).toMatchObject({ resolvedAt: null, mintedAt: null, mintedTokenId: null });
    await expect(db.select().from(magicLinkTokens)).resolves.toHaveLength(0);
    await expect(db.select().from(magicLinkMintLedger)).resolves.toHaveLength(0);
    await expect(
      db.select().from(tasks).where(eq(tasks.kind, "auth.magic_link_email")),
    ).resolves.toHaveLength(0);
  }

  it("keeps Phase A on the legacy shape and permits v2 intake only after the explicit gate", async () => {
    const phaseAEmail = `phase-a-${randomUUID()}@example.test`;
    process.env.MAGIC_LINK_INTAKE_ENABLED = "false";
    __resetEnvForTests();

    await expect(requestMagicLink(phaseAEmail, { ip: "198.51.100.11" })).resolves.toMatchObject({
      suppressed: false,
      tokenId: expect.any(String),
    });
    const [legacy] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, phaseAEmail));
    const [legacyTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.dedupeKey, `auth-magic-link-email:${legacy!.id}`));
    expect(legacy).toMatchObject({ deliveryState: "active", deliveredAt: expect.any(Date) });
    expect(legacyTask).toMatchObject({ queueClass: "transactional" });
    await expect(db.select().from(magicLinkRequests)).resolves.toHaveLength(0);

    process.env.MAGIC_LINK_INTAKE_ENABLED = "true";
    __resetEnvForTests();
    const phaseBEmail = `phase-b-${randomUUID()}@example.test`;
    await expect(requestMagicLink(phaseBEmail, { ip: "198.51.100.11" })).resolves.toEqual({
      suppressed: false,
    });
    const [request] = await db
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.email, phaseBEmail));
    const [intake] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.dedupeKey, `auth-magic-link-request:${request!.id}`));
    expect(request).toMatchObject({ mintedAt: null, mintedTokenId: null });
    expect(intake).toMatchObject({ kind: "auth.magic_link_request", queueClass: "auth_intake" });
  });

  it("reclaims a stopped Phase-A legacy claim into the Phase-B quarantine before an admin can receive SMTP", async () => {
    const email = `phase-a-residue-${randomUUID()}@example.test`;
    process.env.MAGIC_LINK_INTAKE_ENABLED = "false";
    __resetEnvForTests();

    await requestMagicLink(email, { ip: "198.51.100.12" });
    const [legacy] = await db.select().from(tasks).where(eq(tasks.kind, "auth.magic_link_email"));
    expect(legacy).toMatchObject({ queueClass: "transactional", status: "pending" });

    // Phase B is a stop-then-start cutover. Model the final Phase-A worker
    // having acquired, but not started, this task before its process is
    // stopped; its expired claim must be reclaimed by the quarantine worker.
    const phaseAClaim = await claimOneTaskForClass("transactional");
    expect(phaseAClaim?.id).toBe(legacy!.id);
    await db
      .update(tasks)
      .set({ leaseUntil: new Date(0) })
      .where(eq(tasks.id, phaseAClaim!.id));

    // The Phase-B quarantine stage runs before normal administration opens,
    // but the current role is still rechecked defensively in this regression.
    await db.insert(users).values({ email, role: "admin" });

    process.env.MAGIC_LINK_INTAKE_ENABLED = "true";
    __resetEnvForTests();
    const phaseBClaim = await claimOneTaskForClass("transactional");
    expect(phaseBClaim).toMatchObject({ id: legacy!.id, reclaimedStale: true });
    const result = await runTaskHandler(phaseBClaim!);
    await expect(
      markTaskSucceeded(phaseBClaim!.id, phaseBClaim!.lockedBy!, result.note),
    ).resolves.toBe(true);

    expect(result.note).toContain("quarantined");
    expect(mocks.sendMagicLinkEmail).not.toHaveBeenCalled();
    const [stored] = await db.select().from(tasks).where(eq(tasks.id, legacy!.id));
    expect(stored).toMatchObject({ status: "succeeded" });
  });

  it("uses the same public request write shape for admin, member, and unknown mailboxes", async () => {
    const adminEmail = `admin-${randomUUID()}@example.test`;
    const memberEmail = `member-${randomUUID()}@example.test`;
    const unknownEmail = `unknown-${randomUUID()}@example.test`;
    await db.insert(users).values([
      { email: adminEmail, role: "admin" },
      { email: memberEmail, role: "member" },
    ]);

    await expect(requestMagicLink(adminEmail, { ip: "198.51.100.1" })).resolves.toEqual({
      suppressed: false,
    });
    await expect(requestMagicLink(memberEmail, { ip: "198.51.100.1" })).resolves.toEqual({
      suppressed: false,
    });
    await expect(requestMagicLink(unknownEmail, { ip: "198.51.100.1" })).resolves.toEqual({
      suppressed: false,
    });

    const requests = await db.select().from(magicLinkRequests).orderBy(magicLinkRequests.createdAt);
    const intakeTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "auth.magic_link_request"));
    expect(requests).toHaveLength(3);
    expect(intakeTasks).toHaveLength(3);
    expect(requests.every((request) => request.resolvedAt === null)).toBe(true);
    expect(requests.every((request) => request.mintedAt === null)).toBe(true);
    expect(await db.select().from(magicLinkTokens)).toHaveLength(0);
  });

  it("resolves an admin request without minting and commits every successful mint ledger field together", async () => {
    const adminEmail = `admin-${randomUUID()}@example.test`;
    const memberEmail = `member-${randomUUID()}@example.test`;
    await db.insert(users).values({ email: adminEmail, role: "admin" });

    await requestMagicLink(adminEmail, { ip: "198.51.100.2" });
    await requestMagicLink(memberEmail, { ip: "198.51.100.2" });
    await claimAndRun("auth_intake");
    await claimAndRun("auth_intake");

    const adminRequest = await db
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.email, adminEmail));
    expect(adminRequest[0]).toMatchObject({ resolvedAt: expect.any(Date), mintedAt: null });

    const [memberRequest] = await db
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.email, memberEmail));
    expect(memberRequest).toMatchObject({
      resolvedAt: expect.any(Date),
      mintedAt: expect.any(Date),
      mintedTokenId: expect.any(String),
    });

    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, memberRequest!.mintedTokenId!));
    const [ledger] = await db
      .select()
      .from(magicLinkMintLedger)
      .where(eq(magicLinkMintLedger.requestId, memberRequest!.id));
    const [deliveryTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, ledger!.deliveryTaskId));

    expect(candidate).toMatchObject({
      deliveryState: "pending",
      deliveredAt: null,
      expiresAt: new Date(0),
    });
    expect(ledger).toMatchObject({
      mintedTokenId: candidate!.id,
      mintedAt: memberRequest!.mintedAt,
    });
    expect(deliveryTask).toMatchObject({
      kind: "auth.magic_link_email",
      queueClass: "auth_delivery_v2",
    });
  });

  it("does not mint or account twice when a claimed intake handler is retried", async () => {
    const email = `retry-${randomUUID()}@example.test`;
    const intake = await createClaimedIntake(email);

    await expect(runTaskHandler(intake)).resolves.toMatchObject({
      note: "Magic Link v2 delivery task was minted",
    });
    await expect(runTaskHandler(intake)).resolves.toMatchObject({
      note: "Magic Link intake request was already resolved",
    });
    await expect(markTaskSucceeded(intake.id, intake.lockedBy!, "resolved")).resolves.toBe(true);

    const [request] = await db
      .select()
      .from(magicLinkRequests)
      .where(eq(magicLinkRequests.email, email));
    const candidates = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, email));
    const deliveryTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "auth.magic_link_email"));
    const ledger = await db.select().from(magicLinkMintLedger);

    expect(request).toMatchObject({
      resolvedAt: expect.any(Date),
      mintedAt: expect.any(Date),
      mintedTokenId: expect.any(String),
    });
    expect(candidates).toHaveLength(1);
    expect(deliveryTasks).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      requestId: request!.id,
      mintedTokenId: request!.mintedTokenId,
      deliveryTaskId: deliveryTasks[0]!.id,
    });
  });

  it("applies the trusted-IP mint budget only from committed minted_at accounting", async () => {
    const previousBudget = process.env.REQUEST_CODE_EMAIL_IP_RATE_MAX;
    process.env.REQUEST_CODE_EMAIL_IP_RATE_MAX = "1";
    __resetEnvForTests();
    try {
      const email = `budget-${randomUUID()}@example.test`;
      const ip = "198.51.100.44";
      await requestMagicLink(email, { ip });
      await claimAndRun("auth_intake");
      await claimAndRun("auth_delivery_v2");

      // The active candidate no longer qualifies for delivery dedupe, leaving
      // the committed request.minted_at as the only reason the second intake
      // must not mint.
      await db
        .update(magicLinkTokens)
        .set({ expiresAt: new Date(0) })
        .where(eq(magicLinkTokens.email, email));
      await requestMagicLink(email, { ip });
      await claimAndRun("auth_intake");

      const requests = await db
        .select()
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.email, email))
        .orderBy(magicLinkRequests.createdAt);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ mintedAt: expect.any(Date) });
      expect(requests[1]).toMatchObject({ resolvedAt: expect.any(Date), mintedAt: null });
      await expect(
        db.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email)),
      ).resolves.toHaveLength(1);
    } finally {
      if (previousBudget === undefined) delete process.env.REQUEST_CODE_EMAIL_IP_RATE_MAX;
      else process.env.REQUEST_CODE_EMAIL_IP_RATE_MAX = previousBudget;
      __resetEnvForTests();
    }
  });

  it("rolls back candidate, delivery task, request ledger, and immutable ledger together when task creation fails", async () => {
    const email = `rollback-${randomUUID()}@example.test`;
    const intake = await createClaimedIntake(email);

    await db.execute(sql`
      create function olp_test_fail_v2_magic_link_delivery_task()
      returns trigger language plpgsql as $$
      begin
        if new.kind = 'auth.magic_link_email' then
          raise exception 'test v2 delivery task insert failure';
        end if;
        return new;
      end
      $$
    `);
    await db.execute(sql`
      create trigger olp_test_fail_v2_magic_link_delivery_task
      before insert on tasks
      for each row execute function olp_test_fail_v2_magic_link_delivery_task()
    `);
    try {
      await expectPostgresCause(runTaskHandler(intake), /test v2 delivery task insert failure/);
    } finally {
      await db.execute(
        sql`drop trigger if exists olp_test_fail_v2_magic_link_delivery_task on tasks`,
      );
      await db.execute(sql`drop function if exists olp_test_fail_v2_magic_link_delivery_task()`);
    }

    await expectRequestHasNoCommittedMint(email);
  });

  it("rolls back the whole mint when a pending candidate insert fails", async () => {
    const email = `candidate-failure-${randomUUID()}@example.test`;
    const intake = await createClaimedIntake(email);
    await db.execute(sql`
      create function olp_test_fail_v2_magic_link_candidate()
      returns trigger language plpgsql as $$
      begin
        if new.delivery_state = 'pending' then
          raise exception 'test v2 candidate insert failure';
        end if;
        return new;
      end
      $$
    `);
    await db.execute(sql`
      create trigger olp_test_fail_v2_magic_link_candidate
      before insert on magic_link_tokens
      for each row execute function olp_test_fail_v2_magic_link_candidate()
    `);
    try {
      await expectPostgresCause(runTaskHandler(intake), /test v2 candidate insert failure/);
    } finally {
      await db.execute(
        sql`drop trigger if exists olp_test_fail_v2_magic_link_candidate on magic_link_tokens`,
      );
      await db.execute(sql`drop function if exists olp_test_fail_v2_magic_link_candidate()`);
    }
    await expectRequestHasNoCommittedMint(email);
  });

  it("rolls back the whole mint when request accounting fails", async () => {
    const email = `request-failure-${randomUUID()}@example.test`;
    const intake = await createClaimedIntake(email);
    await db.execute(sql`
      create function olp_test_fail_v2_magic_link_request_ledger()
      returns trigger language plpgsql as $$
      begin
        if new.minted_token_id is not null then
          raise exception 'test v2 request ledger update failure';
        end if;
        return new;
      end
      $$
    `);
    await db.execute(sql`
      create trigger olp_test_fail_v2_magic_link_request_ledger
      before update on magic_link_requests
      for each row execute function olp_test_fail_v2_magic_link_request_ledger()
    `);
    try {
      await expectPostgresCause(runTaskHandler(intake), /test v2 request ledger update failure/);
    } finally {
      await db.execute(
        sql`drop trigger if exists olp_test_fail_v2_magic_link_request_ledger on magic_link_requests`,
      );
      await db.execute(sql`drop function if exists olp_test_fail_v2_magic_link_request_ledger()`);
    }
    await expectRequestHasNoCommittedMint(email);
  });

  it("rolls back the whole mint when immutable ledger insertion fails immediately", async () => {
    const email = `ledger-insert-failure-${randomUUID()}@example.test`;
    const intake = await createClaimedIntake(email);
    await db.execute(sql`
      create function olp_test_fail_v2_magic_link_ledger_insert()
      returns trigger language plpgsql as $$
      begin
        raise exception 'test v2 mint ledger insert failure';
      end
      $$
    `);
    await db.execute(sql`
      create trigger olp_test_fail_v2_magic_link_ledger_insert
      before insert on magic_link_mint_ledger
      for each row execute function olp_test_fail_v2_magic_link_ledger_insert()
    `);
    try {
      await expectPostgresCause(runTaskHandler(intake), /test v2 mint ledger insert failure/);
    } finally {
      await db.execute(
        sql`drop trigger if exists olp_test_fail_v2_magic_link_ledger_insert on magic_link_mint_ledger`,
      );
      await db.execute(sql`drop function if exists olp_test_fail_v2_magic_link_ledger_insert()`);
    }
    await expectRequestHasNoCommittedMint(email);
  });

  it("rolls back the whole mint when immutable ledger insertion or commit fails", async () => {
    const email = `ledger-failure-${randomUUID()}@example.test`;
    const intake = await createClaimedIntake(email);
    await db.execute(sql`
      create function olp_test_fail_v2_magic_link_ledger_commit()
      returns trigger language plpgsql as $$
      begin
        raise exception 'test v2 mint ledger deferred commit failure';
      end
      $$
    `);
    await db.execute(sql`
      create constraint trigger olp_test_fail_v2_magic_link_ledger_commit
      after insert on magic_link_mint_ledger
      deferrable initially deferred
      for each row execute function olp_test_fail_v2_magic_link_ledger_commit()
    `);
    try {
      await expect(runTaskHandler(intake)).rejects.toThrow(
        "test v2 mint ledger deferred commit failure",
      );
    } finally {
      await db.execute(
        sql`drop trigger if exists olp_test_fail_v2_magic_link_ledger_commit on magic_link_mint_ledger`,
      );
      await db.execute(sql`drop function if exists olp_test_fail_v2_magic_link_ledger_commit()`);
    }
    await expectRequestHasNoCommittedMint(email);
  });

  it("activates only after SMTP returns and leaves pending rows unverifiable and unconsumable", async () => {
    const email = `delivery-${randomUUID()}@example.test`;
    await requestMagicLink(email, { ip: "198.51.100.4" });
    await claimAndRun("auth_intake");

    const [pending] = await db.select().from(magicLinkTokens);
    expect(pending).toMatchObject({ deliveryState: "pending", deliveredAt: null });
    await claimAndRun("auth_delivery_v2");

    const [active] = await db.select().from(magicLinkTokens);
    expect(mocks.sendMagicLinkEmailWithDeadline).toHaveBeenCalledTimes(1);
    expect(active).toMatchObject({
      id: pending!.id,
      deliveryState: "active",
      deliveredAt: expect.any(Date),
      deliveryReservationId: null,
      deliveryReservationUntil: null,
    });

    const generated = generateMagicLinkToken({
      keyId: "v2-current",
      secret: "v2-current-secret-32-bytes-long!!!!",
    });
    const [nonActive] = await db
      .insert(magicLinkTokens)
      .values({
        email: `pending-${randomUUID()}@example.test`,
        tokenHash: generated.tokenHash,
        keyId: "v2-current",
        expiresAt: new Date(0),
        deliveryState: "pending",
        deliveredAt: null,
      })
      .returning({ id: magicLinkTokens.id });

    await expect(verifyMagicLinkToken(generated.token)).resolves.toEqual({ status: "invalid" });
    await expect(consumeMagicLinkToken(generated.token)).resolves.toEqual({ status: "invalid" });
    await expectPostgresCause(
      db.execute(sql`
        update magic_link_tokens
        set consumed_at = now()
        where id = ${nonActive!.id}
      `),
      /magic_link_token_not_delivered/,
    );
    const [stillPending] = await db
      .select({
        deliveryState: magicLinkTokens.deliveryState,
        consumedAt: magicLinkTokens.consumedAt,
      })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, nonActive!.id));
    expect(stillPending).toEqual({ deliveryState: "pending", consumedAt: null });
  });

  it("does not reserve or send after its task claim lease expires before reclaim", async () => {
    const email = `expired-claim-${randomUUID()}@example.test`;
    const { task, payload } = await createClaimedV2Delivery(email);
    await db
      .update(tasks)
      .set({ leaseUntil: new Date(0) })
      .where(eq(tasks.id, task.id));

    await expect(runTaskHandler(task)).rejects.toThrow(/claim expired before reservation/i);
    expect(mocks.sendMagicLinkEmailWithDeadline).not.toHaveBeenCalled();

    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, payload.tokenId));
    expect(candidate).toMatchObject({
      deliveryState: "pending",
      deliveryReservationId: null,
      deliveryReservationUntil: null,
    });
  });

  it("uses a fresh reservation generation when a confirmed-closed SMTP retry resends the same candidate", async () => {
    const email = `retry-delivery-${randomUUID()}@example.test`;
    const { task: firstTask, payload } = await createClaimedV2Delivery(email);
    const seenReservationIds: string[] = [];
    let attempts = 0;
    mocks.sendMagicLinkEmailWithDeadline.mockImplementation(async () => {
      const [candidate] = await db
        .select()
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.id, payload.tokenId));
      expect(candidate?.deliveryReservationId).toEqual(expect.any(String));
      seenReservationIds.push(candidate!.deliveryReservationId!);
      attempts += 1;
      if (attempts === 1) throw new MailDeliveryError("transient");
    });

    await expect(
      deliverMagicLinkEmailTask(payload, {
        taskId: firstTask.id,
        lockToken: firstTask.lockedBy,
      }),
    ).rejects.toBeInstanceOf(MailDeliveryError);
    const [afterFailure] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, payload.tokenId));
    expect(afterFailure).toMatchObject({
      deliveryState: "pending",
      deliveryReservationId: null,
      deliveryReservationUntil: null,
    });
    await expect(
      markTaskFailed(firstTask.id, firstTask.lockedBy!, new MailDeliveryError("transient")),
    ).resolves.toEqual({ updated: true, status: "failed" });
    await db
      .update(tasks)
      .set({ runAfter: new Date(0) })
      .where(eq(tasks.id, firstTask.id));

    const retryTask = await claimOneTaskForClass("auth_delivery_v2");
    expect(retryTask).not.toBeNull();
    await expect(
      deliverMagicLinkEmailTask(retryTask!.payloadJson as MagicLinkDeliveryV2TaskPayload, {
        taskId: retryTask!.id,
        lockToken: retryTask!.lockedBy,
      }),
    ).resolves.toBeUndefined();
    await expect(markTaskSucceeded(retryTask!.id, retryTask!.lockedBy!)).resolves.toBe(true);

    const candidates = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.email, email));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ deliveryState: "active" });
    expect(seenReservationIds).toHaveLength(2);
    expect(seenReservationIds[1]).not.toBe(seenReservationIds[0]);
  });

  it("does not let a stale delivery invocation clear a replacement reservation generation", async () => {
    const email = `stale-generation-${randomUUID()}@example.test`;
    const { task, payload } = await createClaimedV2Delivery(email);
    const replacementReservationId = randomUUID();
    mocks.sendMagicLinkEmailWithDeadline.mockImplementation(async () => {
      await db
        .update(magicLinkTokens)
        .set({
          deliveryReservationId: replacementReservationId,
          deliveryReservationUntil: new Date(Date.now() + 60_000),
        })
        .where(eq(magicLinkTokens.id, payload.tokenId));
      throw new MailDeliveryError("transient");
    });

    await expect(
      deliverMagicLinkEmailTask(payload, { taskId: task.id, lockToken: task.lockedBy }),
    ).rejects.toThrow(/reservation could not be safely released/i);

    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, payload.tokenId));
    expect(candidate).toMatchObject({
      deliveryState: "pending",
      deliveryReservationId: replacementReservationId,
    });
  });

  it("retains the fence when SMTP has returned but the delivery claim is no longer current", async () => {
    const email = `lost-claim-${randomUUID()}@example.test`;
    const { task, payload } = await createClaimedV2Delivery(email);
    let allowSmtpReturn!: () => void;
    let smtpStarted!: () => void;
    const smtpStartedPromise = new Promise<void>((resolve) => {
      smtpStarted = resolve;
    });
    const smtpReturnPromise = new Promise<void>((resolve) => {
      allowSmtpReturn = resolve;
    });
    mocks.sendMagicLinkEmailWithDeadline.mockImplementation(async () => {
      smtpStarted();
      await smtpReturnPromise;
    });

    const delivery = deliverMagicLinkEmailTask(payload, {
      taskId: task.id,
      lockToken: task.lockedBy,
    });
    await smtpStartedPromise;
    const [reserved] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, payload.tokenId));
    expect(reserved?.deliveryReservationId).toEqual(expect.any(String));
    await db
      .update(tasks)
      .set({ status: "failed", lockedAt: null, lockedBy: null, leaseUntil: null })
      .where(eq(tasks.id, task.id));
    allowSmtpReturn();

    await expect(delivery).resolves.toMatch(/claim is stale after SMTP/i);
    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, payload.tokenId));
    expect(candidate).toMatchObject({
      deliveryState: "pending",
      deliveryReservationId: reserved!.deliveryReservationId,
    });
  });

  it("uses the auditable exact-base 80dbaa verifier/consumer fixture to prove the rollout gate remains necessary", async () => {
    const key = {
      keyId: "v2-current",
      secret: "v2-current-secret-32-bytes-long!!!!",
    };
    const pending = generateMagicLinkToken(key);
    await db.insert(magicLinkTokens).values({
      email: `legacy-pending-${randomUUID()}@example.test`,
      tokenHash: pending.tokenHash,
      keyId: key.keyId,
      expiresAt: new Date(0),
      deliveryState: "pending",
      deliveredAt: null,
    });

    // Exact base code has no delivery_state predicate; its rejection is the
    // epoch placeholder's ordinary expiry predicate, not lifecycle awareness.
    await expect(exactBase80dbaa.verifyMagicLinkToken(pending.token)).resolves.toEqual({
      status: "expired",
    });
    await expect(exactBase80dbaa.consumeMagicLinkToken(pending.token)).resolves.toEqual({
      status: "expired",
    });

    const superseded = generateMagicLinkToken(key);
    await db.insert(magicLinkTokens).values({
      email: `legacy-superseded-${randomUUID()}@example.test`,
      tokenHash: superseded.tokenHash,
      keyId: key.keyId,
      expiresAt: new Date(Date.now() + 60_000),
      deliveryState: "superseded",
      supersededAt: new Date(),
    });
    // The old verifier regards this non-active row as valid. The migration's
    // consumption trigger then blocks the old consumer as defense in depth;
    // neither observation makes it safe to run the old executable in Phase B.
    await expect(exactBase80dbaa.verifyMagicLinkToken(superseded.token)).resolves.toMatchObject({
      status: "valid",
    });
    await expectPostgresCause(
      exactBase80dbaa.consumeMagicLinkToken(superseded.token),
      /magic_link_token_not_delivered/,
    );

    const cancelled = generateMagicLinkToken(key);
    await db.insert(magicLinkTokens).values({
      email: `legacy-cancelled-${randomUUID()}@example.test`,
      tokenHash: cancelled.tokenHash,
      keyId: key.keyId,
      expiresAt: new Date(0),
      deliveryState: "cancelled",
    });
    await expect(exactBase80dbaa.verifyMagicLinkToken(cancelled.token)).resolves.toEqual({
      status: "expired",
    });
    await expect(exactBase80dbaa.consumeMagicLinkToken(cancelled.token)).resolves.toEqual({
      status: "expired",
    });
  });

  it("has database-enforced v2 queue and non-sensitive payload boundaries", async () => {
    await expectPostgresCause(
      db.insert(tasks).values({
        kind: "auth.magic_link_email",
        queueClass: "auth_delivery_v2",
        payloadJson: {
          version: 1,
          deliveryProtocol: 2,
          tokenId: randomUUID(),
          encryptedToken: "fixture-encrypted-token",
          email: "must-not-be-persisted@example.test",
        },
      }),
      /tasks_magic_link_protocol_check/,
    );

    await expectPostgresCause(
      db.insert(tasks).values({
        kind: "auth.magic_link_email",
        queueClass: "transactional",
        payloadJson: {
          version: 1,
          deliveryProtocol: 2,
          tokenId: randomUUID(),
          encryptedToken: "fixture-encrypted-token",
        },
      }),
      /tasks_magic_link_protocol_check/,
    );

    await expectPostgresCause(
      db.insert(tasks).values({
        kind: "auth.magic_link_request",
        queueClass: "auth_intake",
        payloadJson: {
          version: 1,
          requestId: randomUUID(),
          email: "must-not-be-persisted@example.test",
        },
      }),
      /tasks_magic_link_protocol_check/,
    );

    await expectPostgresCause(
      db.insert(tasks).values({
        kind: "auth.magic_link_request",
        queueClass: "auth_intake",
        payloadJson: {
          version: 1,
          requestId: randomUUID(),
          role: "admin",
        },
      }),
      /tasks_magic_link_protocol_check/,
    );
  });
});
