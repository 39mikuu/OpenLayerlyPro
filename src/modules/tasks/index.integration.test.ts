import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { tasks } from "@/db/schema";
import { logger } from "@/lib/logger";

import { dispatchClaimedTask } from "./dispatcher";
import {
  claimDueTasks,
  claimDueTasksAt,
  countMailTaskFailures,
  deferTask,
  enqueueTask,
  listTasks,
  markTaskDead,
  markTaskFailed,
  markTaskFailedAt,
  markTaskSucceeded,
  PermanentTaskError,
  renewTaskLease,
  retryTask,
  taskBackoffMs,
} from "./index";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("durable tasks integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(tasks);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits and rolls back task enqueue with its surrounding transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await enqueueTask(tx, {
          kind: "email",
          dedupeKey: `rollback-${randomUUID()}`,
          payload: { template: "payment_rejected" },
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);

    await db.transaction((tx) =>
      enqueueTask(tx, {
        kind: "email",
        dedupeKey: `commit-${randomUUID()}`,
        payload: { template: "payment_rejected" },
      }),
    );
    await expect(db.select().from(tasks)).resolves.toHaveLength(1);
  });

  it("deduplicates non-null keys while allowing tasks without keys", async () => {
    const dedupeKey = `email-${randomUUID()}`;
    await db.transaction(async (tx) => {
      await enqueueTask(tx, { kind: "email", dedupeKey, payload: { value: 1 } });
      await enqueueTask(tx, { kind: "email", dedupeKey, payload: { value: 2 } });
      await enqueueTask(tx, { kind: "email", payload: { value: 3 } });
      await enqueueTask(tx, { kind: "email", payload: { value: 4 } });
    });

    const rows = await db.select().from(tasks);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.dedupeKey === dedupeKey)).toHaveLength(1);
    expect(rows.filter((row) => row.dedupeKey === null)).toHaveLength(2);
  });

  it("claims due work, leaves future work alone, and records a lease", async () => {
    const now = new Date("2026-06-18T10:00:00.000Z");
    const [due, future] = await db
      .insert(tasks)
      .values([
        { kind: "email", payloadJson: {}, runAfter: new Date(now.getTime() - 1_000) },
        { kind: "email", payloadJson: {}, runAfter: new Date(now.getTime() + 60_000) },
      ])
      .returning();

    const claimed = await claimDueTasksAt(10, now, {
      lockToken: "worker-a",
      leaseMs: 60_000,
    });

    expect(claimed.map((task) => task.id)).toEqual([due!.id]);
    expect(claimed[0]).toMatchObject({
      status: "processing",
      attempts: 1,
      lockedBy: "worker-a",
      lockedAt: now,
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    const [storedFuture] = await db.select().from(tasks).where(eq(tasks.id, future!.id));
    expect(storedFuture).toMatchObject({ status: "pending", lockedBy: null });
  });

  it("does not let concurrent workers claim the same task", async () => {
    const now = new Date("2026-06-18T10:00:00.000Z");
    await db.insert(tasks).values([
      { kind: "email", payloadJson: {}, runAfter: new Date(now.getTime() - 2_000) },
      { kind: "email", payloadJson: {}, runAfter: new Date(now.getTime() - 1_000) },
    ]);

    const [first, second] = await Promise.all([
      claimDueTasksAt(1, now, { lockToken: "worker-a" }),
      claimDueTasksAt(1, now, { lockToken: "worker-b" }),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });

  it("reclaims processing work after its lease expires", async () => {
    const now = new Date("2026-06-18T10:00:00.000Z");
    const [expiredLease] = await db
      .insert(tasks)
      .values({
        kind: "email",
        payloadJson: {},
        status: "processing",
        attempts: 1,
        lockedBy: "dead-worker",
        lockedAt: new Date(now.getTime() - 120_000),
        leaseUntil: new Date(now.getTime() - 1_000),
      })
      .returning();

    const claimed = await claimDueTasksAt(1, now, { lockToken: "worker-b" });

    expect(claimed[0]).toMatchObject({
      id: expiredLease!.id,
      status: "processing",
      attempts: 2,
      lockedBy: "worker-b",
    });
  });

  it("counts lease recovery as a new execution and does not exceed max attempts", async () => {
    const now = new Date("2026-06-18T10:00:00.000Z");
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "email",
        payloadJson: {},
        runAfter: now,
        maxAttempts: 2,
      })
      .returning();

    const [claimedByA] = await claimDueTasksAt(1, now, {
      lockToken: "claim-a",
      leaseMs: 1_000,
    });
    expect(claimedByA).toMatchObject({ id: created!.id, attempts: 1 });

    const recoveryTime = new Date(now.getTime() + 2_000);
    const [claimedByB] = await claimDueTasksAt(1, recoveryTime, {
      lockToken: "claim-b",
      leaseMs: 1_000,
    });
    expect(claimedByB).toMatchObject({ id: created!.id, attempts: 2 });

    const afterFinalLease = new Date(recoveryTime.getTime() + 2_000);
    await expect(claimDueTasksAt(1, afterFinalLease, { lockToken: "claim-c" })).resolves.toEqual(
      [],
    );
    const [stored] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
    expect(stored).toMatchObject({
      status: "dead",
      attempts: 2,
      lockedBy: null,
      leaseUntil: null,
      lastError: "Task lease expired after the final execution attempt",
    });
  });

  it("fences stale success and failure updates after another worker reclaims the task", async () => {
    const now = new Date("2026-06-18T10:00:00.000Z");
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "email",
        payloadJson: {},
        runAfter: now,
      })
      .returning();

    const [claimedByA] = await claimDueTasksAt(1, now, {
      lockToken: "claim-a",
      leaseMs: 1_000,
    });
    const [claimedByB] = await claimDueTasksAt(1, new Date(now.getTime() + 2_000), {
      lockToken: "claim-b",
    });
    expect(claimedByA?.id).toBe(created!.id);
    expect(claimedByB).toMatchObject({ id: created!.id, lockedBy: "claim-b" });

    await expect(markTaskSucceeded(created!.id, "claim-a")).resolves.toBe(false);
    const [stillOwnedByB] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
    expect(stillOwnedByB).toMatchObject({ status: "processing", lockedBy: "claim-b" });

    await expect(markTaskSucceeded(created!.id, "claim-b")).resolves.toBe(true);
    await expect(
      markTaskFailedAt(
        created!.id,
        "claim-a",
        new Error("late failure"),
        new Date(now.getTime() + 3_000),
      ),
    ).resolves.toEqual({ updated: false, status: null });
    const [completed] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
    expect(completed).toMatchObject({
      status: "succeeded",
      attempts: 2,
      lockedBy: null,
      lastError: null,
    });
  });

  it("renews a lease only for the current claim token", async () => {
    const now = new Date(Date.now() - 1_000);
    const [created] = await db
      .insert(tasks)
      .values({ kind: "email", payloadJson: {}, runAfter: now })
      .returning();
    await claimDueTasksAt(1, now, { lockToken: "current-claim", leaseMs: 2_000 });
    const [before] = await db.select().from(tasks).where(eq(tasks.id, created!.id));

    await expect(renewTaskLease(created!.id, "stale-claim", 60_000)).resolves.toBe(false);
    await expect(renewTaskLease(created!.id, "current-claim", 60_000)).resolves.toBe(true);

    const [renewed] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
    expect(renewed?.leaseUntil?.getTime()).toBeGreaterThan(before!.leaseUntil!.getTime());
    expect(renewed).toMatchObject({ status: "processing", lockedBy: "current-claim" });
  });

  it("uses failed while waiting, reclaims only when due, and enters dead on attempt five", async () => {
    const start = new Date("2026-06-18T10:00:00.000Z");
    const [created] = await db
      .insert(tasks)
      .values({ kind: "email", payloadJson: {}, runAfter: start, maxAttempts: 5 })
      .returning();
    const expectedBackoffs = [60_000, 120_000, 240_000, 480_000];
    let claimTime = start;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const lockToken = `claim-${attempt}`;
      const [claimed] = await claimDueTasksAt(1, claimTime, { lockToken });
      expect(claimed).toMatchObject({
        id: created!.id,
        attempts: attempt,
        lockedBy: lockToken,
      });

      const failedAt = new Date(claimTime.getTime() + 1_000);
      await expect(
        markTaskFailedAt(created!.id, lockToken, `failure-${attempt}`, failedAt),
      ).resolves.toEqual({ updated: true, status: attempt === 5 ? "dead" : "failed" });
      const [stored] = await db.select().from(tasks).where(eq(tasks.id, created!.id));

      if (attempt === 5) {
        expect(stored).toMatchObject({ status: "dead", attempts: 5, lockedBy: null });
        break;
      }

      const backoff = expectedBackoffs[attempt - 1]!;
      const expectedRunAfter = new Date(failedAt.getTime() + backoff);
      expect(taskBackoffMs(attempt)).toBe(backoff);
      expect(stored).toMatchObject({
        status: "failed",
        attempts: attempt,
        runAfter: expectedRunAfter,
        lockedBy: null,
      });

      await expect(
        claimDueTasksAt(1, new Date(expectedRunAfter.getTime() - 1), {
          lockToken: `too-early-${attempt}`,
        }),
      ).resolves.toEqual([]);
      claimTime = expectedRunAfter;
    }
  });

  it("uses PostgreSQL time for production claim, lease, and failure backoff", async () => {
    const [due, future] = await db
      .insert(tasks)
      .values([
        { kind: "email", payloadJson: {}, runAfter: sql`now() - interval '1 second'` },
        { kind: "email", payloadJson: {}, runAfter: sql`now() + interval '1 hour'` },
      ])
      .returning();

    const [claimed] = await claimDueTasks(1, { lockToken: "database-clock", leaseMs: 30_000 });
    expect(claimed).toMatchObject({
      id: due!.id,
      status: "processing",
      attempts: 1,
      lockedBy: "database-clock",
    });
    expect(claimed!.lockedAt).toBeInstanceOf(Date);
    expect(claimed!.leaseUntil!.getTime() - claimed!.lockedAt!.getTime()).toBe(30_000);
    const [storedFuture] = await db.select().from(tasks).where(eq(tasks.id, future!.id));
    expect(storedFuture).toMatchObject({ status: "pending", attempts: 0 });

    await expect(
      markTaskFailed(due!.id, "database-clock", new Error("temporary database error")),
    ).resolves.toEqual({ updated: true, status: "failed" });
    const [failed] = await db.select().from(tasks).where(eq(tasks.id, due!.id));
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(failed!.runAfter.getTime() - failed!.updatedAt.getTime()).toBe(60_000);
  });

  it("defers precisely with fencing and restores the claimed attempt budget", async () => {
    const deferUntil = new Date("2026-06-20T12:34:56.000Z");
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "publish_post",
        payloadJson: {},
        status: "processing",
        attempts: 1,
        lockedBy: "current-claim",
        lockedAt: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .returning();

    await expect(deferTask(created!.id, "stale-claim", deferUntil)).resolves.toBe(false);
    await expect(deferTask(created!.id, "current-claim", deferUntil)).resolves.toBe(true);
    const [deferred] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
    expect(deferred).toMatchObject({
      status: "pending",
      attempts: 0,
      runAfter: deferUntil,
      lockedAt: null,
      lockedBy: null,
      leaseUntil: null,
      lastError: null,
    });

    await db
      .update(tasks)
      .set({ status: "processing", attempts: 0, lockedBy: "zero-claim" })
      .where(eq(tasks.id, created!.id));
    await expect(deferTask(created!.id, "zero-claim", deferUntil)).resolves.toBe(true);
    const [zero] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
    expect(zero!.attempts).toBe(0);
  });

  it("marks permanent failures dead with claim fencing and a safe summary", async () => {
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "publish_post",
        payloadJson: { secret: "must-not-leak" },
        status: "processing",
        attempts: 1,
        lockedBy: "current-claim",
      })
      .returning();
    const error = new PermanentTaskError("Invalid publish_post payload");

    await expect(markTaskDead(created!.id, "stale-claim", error)).resolves.toEqual({
      updated: false,
      status: null,
    });
    await expect(markTaskDead(created!.id, "current-claim", error)).resolves.toEqual({
      updated: true,
      status: "dead",
    });
    const [dead] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
    expect(dead).toMatchObject({
      status: "dead",
      attempts: 1,
      lockedBy: null,
      lastError: "Invalid publish_post payload",
    });
    expect(dead!.lastError).not.toContain("must-not-leak");
  });

  it("sends malformed publish_post payload directly to dead on its first claim", async () => {
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "publish_post",
        payloadJson: { postId: "not-a-uuid", privateValue: "must-not-leak" },
        runAfter: sql`now() - interval '1 second'`,
      })
      .returning();
    const [claimed] = await claimDueTasks(1, { lockToken: "malformed-claim" });
    expect(claimed).toMatchObject({ id: created!.id, attempts: 1 });

    await dispatchClaimedTask(claimed!);

    const [dead] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
    expect(dead).toMatchObject({
      status: "dead",
      attempts: 1,
      lockedBy: null,
      lastError: "Invalid publish_post payload",
    });
    expect(dead!.lastError).not.toContain("must-not-leak");
  });

  it("logs a safe WARN after an explicit mail dead transition", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const codeId = randomUUID();
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "auth.login_code_email",
        payloadJson: { version: 1, codeId, encryptedCode: "must-not-leak" },
        status: "processing",
        attempts: 1,
        lockedBy: "current-claim",
      })
      .returning();

    await expect(
      markTaskDead(
        created!.id,
        "current-claim",
        new PermanentTaskError("SMTP unavailable for login code", {
          classification: "needs_operator",
        }),
      ),
    ).resolves.toEqual({ updated: true, status: "dead" });

    expect(warn).toHaveBeenCalledWith("email task dead-lettered", {
      taskId: created!.id,
      kind: "auth.login_code_email",
      attempts: 1,
      classification: "needs_operator",
      codeId,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-leak");
    warn.mockRestore();
  });

  it("WARNs only when transient mail retries actually cross into dead", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const [retryable, exhausted] = await db
      .insert(tasks)
      .values([
        {
          kind: "email",
          payloadJson: { to: "fan@example.com", body: "private" },
          status: "processing",
          attempts: 1,
          maxAttempts: 5,
          lockedBy: "retryable-claim",
        },
        {
          kind: "email",
          payloadJson: { to: "other@example.com", body: "private" },
          status: "processing",
          attempts: 5,
          maxAttempts: 5,
          lockedBy: "exhausted-claim",
        },
      ])
      .returning();

    await expect(
      markTaskFailedAt(
        retryable!.id,
        "retryable-claim",
        new Error("fan@example.com body=private"),
        new Date(),
      ),
    ).resolves.toEqual({ updated: true, status: "failed" });
    expect(warn).not.toHaveBeenCalled();

    await expect(
      markTaskFailedAt(
        exhausted!.id,
        "exhausted-claim",
        new Error("other@example.com body=private"),
        new Date(),
      ),
    ).resolves.toEqual({ updated: true, status: "dead" });
    expect(warn).toHaveBeenCalledWith("email task dead-lettered", {
      taskId: exhausted!.id,
      kind: "email",
      attempts: 5,
      classification: "transient",
    });

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, exhausted!.id));
    expect(stored?.lastError).toBe("Email delivery failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("other@example.com");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("body=private");
    warn.mockRestore();
  });

  it("logs lease-expiry dead letters for mail tasks after the sweep commits", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const now = new Date("2026-06-26T12:00:00.000Z");
    const codeId = randomUUID();
    const [created] = await db
      .insert(tasks)
      .values({
        kind: "auth.login_code_email",
        payloadJson: { version: 1, codeId, encryptedCode: "must-not-leak" },
        status: "processing",
        attempts: 5,
        maxAttempts: 5,
        lockedBy: "crashed-worker",
        lockedAt: new Date(now.getTime() - 120_000),
        leaseUntil: new Date(now.getTime() - 1_000),
      })
      .returning();

    await expect(claimDueTasksAt(1, now, { lockToken: "recovery-worker" })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith("email task dead-lettered", {
      taskId: created!.id,
      kind: "auth.login_code_email",
      attempts: 5,
      classification: "lease_expired",
      codeId,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-leak");
    warn.mockRestore();
  });

  it("counts mail failures exactly beyond the 200-row admin list limit", async () => {
    await db.insert(tasks).values([
      ...Array.from({ length: 205 }, (_, index) => ({
        kind: "email",
        payloadJson: { index },
        status: "failed" as const,
        lastError: "temporary",
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        kind: "email",
        payloadJson: { index },
        status: "dead" as const,
        lastError: "permanent",
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        kind: "auth.login_code_email",
        payloadJson: { version: 1, codeId: randomUUID(), encryptedCode: `encrypted-${index}` },
        status: "failed" as const,
        lastError: "temporary",
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        kind: "auth.login_code_email",
        payloadJson: { version: 1, codeId: randomUUID(), encryptedCode: `encrypted-${index}` },
        status: "dead" as const,
        lastError: "permanent",
      })),
      {
        kind: "publish_post",
        payloadJson: {},
        status: "failed" as const,
        lastError: "not mail",
      },
    ]);

    await expect(listTasks({ status: "failed", limit: 200 })).resolves.toHaveLength(200);
    await expect(countMailTaskFailures()).resolves.toEqual({
      businessEmail: { failed: 205, dead: 3 },
      loginCodeEmail: { failed: 4, dead: 5 },
    });
  });

  it("allows manual retry for failed and dead tasks and returns only the admin view", async () => {
    const now = new Date("2026-06-18T10:00:00.000Z");
    const [failed, dead] = await db
      .insert(tasks)
      .values([
        {
          kind: "email",
          dedupeKey: "private-dedupe",
          payloadJson: { to: "private@example.com" },
          status: "failed",
          attempts: 2,
          runAfter: new Date(now.getTime() + 60_000),
          lastError: "temporary",
        },
        {
          kind: "email",
          payloadJson: { to: "private@example.com" },
          status: "dead",
          attempts: 5,
          lastError: "exhausted",
        },
      ])
      .returning();

    for (const task of [failed!, dead!]) {
      const retried = await retryTask(task.id);
      expect(retried).toMatchObject({
        id: task.id,
        status: "pending",
        attempts: 0,
        lastError: null,
      });
      expect(retried).not.toHaveProperty("payloadJson");
      expect(retried).not.toHaveProperty("dedupeKey");
      expect(retried).not.toHaveProperty("lockedBy");
      expect(retried).not.toHaveProperty("lockedAt");
      expect(retried).not.toHaveProperty("leaseUntil");
    }
  });
});
