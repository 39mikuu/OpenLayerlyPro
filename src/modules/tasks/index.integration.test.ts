import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { tasks } from "@/db/schema";

import { claimDueTasks, enqueueTask, markTaskFailed, retryTask, taskBackoffMs } from "./index";

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

    const claimed = await claimDueTasks(10, {
      workerId: "worker-a",
      now,
      leaseMs: 60_000,
    });

    expect(claimed.map((task) => task.id)).toEqual([due!.id]);
    expect(claimed[0]).toMatchObject({
      status: "processing",
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
      claimDueTasks(1, { workerId: "worker-a", now }),
      claimDueTasks(1, { workerId: "worker-b", now }),
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
        lockedBy: "dead-worker",
        lockedAt: new Date(now.getTime() - 120_000),
        leaseUntil: new Date(now.getTime() - 1_000),
      })
      .returning();

    const claimed = await claimDueTasks(1, { workerId: "worker-b", now });

    expect(claimed[0]).toMatchObject({
      id: expiredLease!.id,
      status: "processing",
      lockedBy: "worker-b",
    });
  });

  it("reschedules failures with exponential backoff and eventually marks them dead", async () => {
    const now = new Date("2026-06-18T10:00:00.000Z");
    const [task] = await db
      .insert(tasks)
      .values({
        kind: "email",
        payloadJson: {},
        status: "processing",
        maxAttempts: 2,
      })
      .returning();

    await markTaskFailed(task!.id, new Error("temporary SMTP failure"), now);
    const [retrying] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(retrying).toMatchObject({
      status: "pending",
      attempts: 1,
      runAfter: new Date(now.getTime() + taskBackoffMs(1)),
      lockedBy: null,
    });
    expect(retrying?.lastError).toContain("temporary SMTP failure");

    await markTaskFailed(task!.id, "still failing", new Date(now.getTime() + 1_000));
    const [dead] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(dead).toMatchObject({ status: "dead", attempts: 2, lockedBy: null });

    const retried = await retryTask(task!.id);
    expect(retried).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
  });
});
