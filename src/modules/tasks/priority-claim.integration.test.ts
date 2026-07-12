import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { tasks } from "@/db/schema";

import { dispatchTaskBatch } from "./dispatcher";
import { enqueueTask } from "./enqueue";
import {
  claimDueTasks,
  deferTask,
  markTaskDead,
  markTaskFailed,
  markTaskSucceeded,
  renewTaskLease,
  sweepExpiredFinalAttemptTasks,
  TASK_BATCH_SIZE,
} from "./index";
import type { TaskQueueClass } from "./queue-class";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type PlanNode = {
  "Node Type"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
};

type ExplainRow = {
  "QUERY PLAN": Array<{ Plan: PlanNode }>;
};

function walkPlan(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(walkPlan)];
}

function findPlanPath(plan: PlanNode, predicate: (node: PlanNode) => boolean): PlanNode[] | null {
  if (predicate(plan)) return [plan];
  for (const child of plan.Plans ?? []) {
    const path = findPlanPath(child, predicate);
    if (path) return [plan, ...path];
  }
  return null;
}

function expectBoundedClassClaimPlan(
  plan: PlanNode,
  indexName: "tasks_claimable_class_due_idx" | "tasks_stale_class_due_idx",
): void {
  const allNodes = walkPlan(plan);
  expect(allNodes.some((node) => node["Node Type"] === "Sort")).toBe(false);

  const pathToIndexScan = findPlanPath(plan, (node) => node["Index Name"] === indexName);
  expect(pathToIndexScan).not.toBeNull();
  expect(pathToIndexScan!.map((node) => node["Node Type"])).toEqual(
    expect.arrayContaining(["Limit", "LockRows", "Index Scan"]),
  );
  expect(pathToIndexScan!.findIndex((node) => node["Node Type"] === "Limit")).toBeLessThan(
    pathToIndexScan!.findIndex((node) => node["Node Type"] === "LockRows"),
  );
  expect(pathToIndexScan!.findIndex((node) => node["Node Type"] === "LockRows")).toBeLessThan(
    pathToIndexScan!.findIndex((node) => node["Index Name"] === indexName),
  );
}

async function explainDueClaim(queueClass: TaskQueueClass): Promise<PlanNode> {
  const rows = await getDb().transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    return tx.execute<ExplainRow>(sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
      WITH candidate AS (
        SELECT id
        FROM tasks
        WHERE queue_class = ${queueClass}
          AND status IN ('pending','failed')
          AND run_after <= now()
          AND attempts < max_attempts
        ORDER BY run_after ASC, priority ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks
      SET status = 'processing',
          attempts = attempts + 1,
          locked_at = now(),
          locked_by = 'explain-worker',
          lease_until = now() + (60000 * interval '1 millisecond'),
          updated_at = now()
      FROM candidate
      WHERE tasks.id = candidate.id
      RETURNING tasks.*;
    `);
  });
  return rows[0]!["QUERY PLAN"][0]!.Plan;
}

async function explainStaleClaim(queueClass: TaskQueueClass): Promise<PlanNode> {
  const rows = await getDb().transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    return tx.execute<ExplainRow>(sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF, TIMING OFF, SUMMARY OFF)
      WITH candidate AS (
        SELECT id
        FROM tasks
        WHERE queue_class = ${queueClass}
          AND status = 'processing'
          AND lease_until < now()
          AND attempts < max_attempts
        ORDER BY lease_until ASC, priority ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tasks
      SET status = 'processing',
          attempts = attempts + 1,
          locked_at = now(),
          locked_by = 'explain-worker',
          lease_until = now() + (60000 * interval '1 millisecond'),
          updated_at = now()
      FROM candidate
      WHERE tasks.id = candidate.id
      RETURNING tasks.*;
    `);
  });
  return rows[0]!["QUERY PLAN"][0]!.Plan;
}

describeWithDatabase("priority task class claims", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(tasks);
  });

  it("classifies queue class and priority by task kind at enqueue time", async () => {
    // Raw inserts model pre-classification rows: they must land on the DDL
    // defaults; every real enqueue path classifies through enqueueTask.
    const enqueueInputs: Array<{ kind: string; payload: Record<string, unknown> }> = [
      { kind: "auth.login_code_email", payload: { version: 1 } },
      { kind: "email", payload: { template: "payment_rejected" } },
      { kind: "subscription.renewal_reminder", payload: { subscriptionId: randomUUID() } },
      { kind: "publish_post", payload: { postId: randomUUID() } },
      { kind: "payment_provider_event.dispatch", payload: { eventRowId: randomUUID() } },
      { kind: "subscription.reconcile", payload: {} },
      { kind: "notification.campaign_expand", payload: { version: 1, campaignId: randomUUID() } },
      { kind: "notification.deliver", payload: { version: 1, userId: randomUUID() } },
      { kind: "notification.campaign_finalize", payload: { version: 1, campaignId: randomUUID() } },
      { kind: "file.cleanup_orphan", payload: { fileId: randomUUID() } },
      { kind: "storage.delete_object", payload: { objectKey: "x", bucket: null } },
      { kind: "payment_proof.cleanup", payload: { requestId: randomUUID(), fileId: randomUUID() } },
    ];
    for (const input of enqueueInputs) {
      await enqueueTask(db, input);
    }
    await db.insert(tasks).values([{ kind: "custom.unknown", payloadJson: {} }]);

    const rows = await db.execute<{
      kind: string;
      queue_class: TaskQueueClass;
      priority: number;
    }>(sql`
      SELECT kind, queue_class, priority
      FROM tasks
      ORDER BY kind
    `);
    const byKind = new Map(rows.map((row) => [row.kind, row]));

    expect(byKind.get("auth.login_code_email")).toMatchObject({
      queue_class: "transactional",
      priority: 0,
    });
    expect(byKind.get("email")).toMatchObject({ queue_class: "transactional", priority: 10 });
    expect(byKind.get("subscription.renewal_reminder")).toMatchObject({
      queue_class: "transactional",
      priority: 10,
    });
    expect(byKind.get("publish_post")).toMatchObject({ queue_class: "default", priority: 20 });
    expect(byKind.get("payment_provider_event.dispatch")).toMatchObject({
      queue_class: "default",
      priority: 20,
    });
    expect(byKind.get("subscription.reconcile")).toMatchObject({
      queue_class: "default",
      priority: 30,
    });
    expect(byKind.get("notification.campaign_expand")).toMatchObject({
      queue_class: "notification",
      priority: 80,
    });
    expect(byKind.get("notification.deliver")).toMatchObject({
      queue_class: "notification",
      priority: 90,
    });
    expect(byKind.get("notification.campaign_finalize")).toMatchObject({
      queue_class: "notification",
      priority: 95,
    });
    expect(byKind.get("file.cleanup_orphan")).toMatchObject({
      queue_class: "maintenance",
      priority: 120,
    });
    expect(byKind.get("storage.delete_object")).toMatchObject({
      queue_class: "maintenance",
      priority: 120,
    });
    expect(byKind.get("payment_proof.cleanup")).toMatchObject({
      queue_class: "maintenance",
      priority: 120,
    });
    expect(byKind.get("custom.unknown")).toMatchObject({ queue_class: "default", priority: 100 });
  });

  it("claims due and stale class-specific work with bounded indexed plans", async () => {
    await db.execute(sql`
      INSERT INTO tasks(kind, payload_json, run_after, status, attempts, max_attempts, priority, queue_class)
      SELECT 'notification.deliver', '{}'::jsonb, now() + interval '1 day', 'pending', 0, 5, 90, 'notification'
      FROM generate_series(1, 2000);
    `);
    await db.execute(sql`
      INSERT INTO tasks(kind, payload_json, run_after, status, attempts, max_attempts, priority, queue_class)
      SELECT 'notification.deliver', '{}'::jsonb, now() - interval '1 minute', 'succeeded', 1, 5, 90, 'notification'
      FROM generate_series(1, 2000);
    `);
    await db.execute(sql`
      INSERT INTO tasks(kind, payload_json, run_after, status, attempts, max_attempts, priority, queue_class)
      VALUES
        ('notification.deliver', '{}'::jsonb, now() - interval '10 seconds', 'pending', 0, 5, 90, 'notification'),
        ('notification.deliver', '{}'::jsonb, now() - interval '5 seconds', 'failed', 1, 5, 80, 'notification'),
        ('notification.deliver', '{}'::jsonb, now() - interval '5 minutes', 'processing', 1, 5, 90, 'notification');
    `);
    await db.execute(sql`
      UPDATE tasks
      SET locked_by = 'stale-worker',
          locked_at = now() - interval '2 minutes',
          lease_until = now() - interval '1 second'
      WHERE status = 'processing';
    `);
    await db.execute(sql`analyze tasks`);

    expectBoundedClassClaimPlan(
      await explainDueClaim("notification"),
      "tasks_claimable_class_due_idx",
    );
    expectBoundedClassClaimPlan(
      await explainStaleClaim("notification"),
      "tasks_stale_class_due_idx",
    );
  });

  it("preserves transactional reserve, notification progress, and default progress across ticks", async () => {
    await db.execute(sql`
      INSERT INTO tasks(kind, payload_json, run_after, status, attempts, max_attempts, priority, queue_class)
      SELECT 'email', '{}'::jsonb, now() - interval '1 second', 'pending', 0, 5, 10, 'transactional'
      FROM generate_series(1, 60);
    `);
    await db.execute(sql`
      INSERT INTO tasks(kind, payload_json, run_after, status, attempts, max_attempts, priority, queue_class)
      SELECT 'notification.deliver', '{}'::jsonb, now() - interval '1 second', 'pending', 0, 5, 90, 'notification'
      FROM generate_series(1, 6);
    `);
    await db.execute(sql`
      INSERT INTO tasks(kind, payload_json, run_after, status, attempts, max_attempts, priority, queue_class)
      SELECT 'publish_post', '{}'::jsonb, now() - interval '1 second', 'pending', 0, 5, 20, 'default'
      FROM generate_series(1, 20);
    `);

    const seen: TaskQueueClass[] = [];
    const deps = {
      claim: claimDueTasks,
      run: vi.fn(async (task: { queueClass: TaskQueueClass }) => {
        seen.push(task.queueClass);
        return {};
      }),
      succeed: markTaskSucceeded,
      fail: markTaskFailed,
      dead: markTaskDead,
      defer: deferTask,
      renew: renewTaskLease,
      sweep: sweepExpiredFinalAttemptTasks,
    };

    await expect(dispatchTaskBatch(deps)).resolves.toBe(TASK_BATCH_SIZE);
    await expect(dispatchTaskBatch(deps)).resolves.toBe(TASK_BATCH_SIZE);

    expect(seen.filter((kind) => kind === "transactional")).toHaveLength(32);
    expect(seen.filter((kind) => kind === "notification")).toHaveLength(4);
    expect(seen.filter((kind) => kind === "default")).toHaveLength(4);
    // Each tick guarantees the notification and default minimums without giving
    // up the transactional reserve; position after the reserve is not part of
    // the contract.
    const firstTick = seen.slice(0, TASK_BATCH_SIZE);
    const secondTick = seen.slice(TASK_BATCH_SIZE);
    for (const tick of [firstTick, secondTick]) {
      expect(tick.filter((kind) => kind === "notification")).toHaveLength(2);
      expect(tick.filter((kind) => kind === "default")).toHaveLength(2);
      expect(tick.filter((kind) => kind === "transactional")).toHaveLength(16);
      expect(tick.slice(0, 8)).toEqual(Array<TaskQueueClass>(8).fill("transactional"));
    }
  });

  it("caps notification stale reclaim while keeping due notifications eligible", async () => {
    await db.execute(sql`
      INSERT INTO tasks(kind, payload_json, run_after, status, attempts, max_attempts, priority, queue_class)
      SELECT 'notification.deliver', '{}'::jsonb, now() - interval '5 minutes', 'processing', 1, 5, 90, 'notification'
      FROM generate_series(1, 10);
    `);
    await db.execute(sql`
      UPDATE tasks
      SET locked_by = 'stale-worker',
          locked_at = now() - interval '2 minutes',
          lease_until = now() - interval '1 second'
      WHERE status = 'processing';
    `);
    await db.execute(sql`
      INSERT INTO tasks(kind, payload_json, run_after, status, attempts, max_attempts, priority, queue_class)
      SELECT 'notification.deliver', '{}'::jsonb, now() - interval '1 second', 'pending', 0, 5, 90, 'notification'
      FROM generate_series(1, 30);
    `);

    const seen: Array<{ reclaimedStale: boolean }> = [];
    const deps = {
      claim: claimDueTasks,
      run: vi.fn(async (task: { id: string }) => {
        seen.push({
          reclaimedStale: (task as { reclaimedStale?: boolean }).reclaimedStale === true,
        });
        return {};
      }),
      succeed: markTaskSucceeded,
      fail: markTaskFailed,
      dead: markTaskDead,
      defer: deferTask,
      renew: renewTaskLease,
      sweep: sweepExpiredFinalAttemptTasks,
    };

    await expect(dispatchTaskBatch(deps)).resolves.toBe(TASK_BATCH_SIZE);

    expect(seen).toHaveLength(TASK_BATCH_SIZE);
    expect(seen.filter((entry) => entry.reclaimedStale)).toHaveLength(2);
    const remainingStale = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM tasks
      WHERE queue_class = 'notification'
        AND status = 'processing'
        AND locked_by = 'stale-worker'
        AND lease_until < now()
    `);
    expect(remainingStale[0]!.count).toBe(8);
  });
});
