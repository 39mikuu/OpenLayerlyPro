import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { tasks } from "@/db/schema";

import { dispatchClaimedTask } from "./dispatcher";
import {
  claimDueTasks,
  claimDueTasksAt,
  deferTask,
  enqueueTask,
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
    ).resolves.toBe(false);
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
      ).resolves.toBe(true);
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
    ).resolves.toBe(true);
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

    await expect(markTaskDead(created!.id, "stale-claim", error)).resolves.toBe(false);
    await expect(markTaskDead(created!.id, "current-claim", error)).resolves.toBe(true);
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
