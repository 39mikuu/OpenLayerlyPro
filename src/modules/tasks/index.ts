import { randomUUID } from "crypto";
import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";

import { getDb } from "@/db";
import {
  notificationCampaigns,
  notificationDeliveries,
  notificationDeliveryAttempts,
  paymentProviderEvents,
  type Task,
  tasks,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { logger } from "@/lib/logger";

import { DEFAULT_MAX_ATTEMPTS, enqueueTask, enqueueTaskReturningId } from "./enqueue";
import { PermanentTaskError, type TaskFailureClassification } from "./errors";
import { paymentProviderEventPayloadSchema } from "./payloads";
import { type TaskQueueClass } from "./queue-class";

export {
  DEFAULT_MAX_ATTEMPTS,
  enqueueTask,
  enqueueTaskReturningId,
  PermanentTaskError,
  type TaskQueueClass,
};

// Total execution limit: failures 1-4 retry after 1m/2m/4m/8m; failure 5 is dead.
export const TASK_LEASE_MS = 60_000;
export const TASK_BATCH_SIZE = 20;
export const TASK_POLL_INTERVAL_MS = 10_000;
export const TASK_ERROR_MAX_LENGTH = 2_000;

export type TaskStatus = Task["status"];
export type TaskAdminView = Pick<
  Task,
  "id" | "kind" | "status" | "attempts" | "maxAttempts" | "runAfter" | "lastError" | "createdAt"
>;

export type TaskFinalizationResult =
  | { updated: false; status: null }
  | { updated: true; status: "failed" | "dead" };

export type MailTaskFailureCounts = {
  businessEmail: { failed: number; dead: number };
  loginCodeEmail: { failed: number; dead: number };
};

export type DeadLetterTask = Pick<Task, "id" | "kind" | "attempts" | "payloadJson">;

function isMailTaskKind(kind: string): boolean {
  return kind === "email" || kind === "auth.login_code_email";
}

function loginCodeIdFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const codeId = (payload as { codeId?: unknown }).codeId;
  return typeof codeId === "string" ? codeId : undefined;
}

function warnMailTaskDeadLettered(
  task: DeadLetterTask,
  classification: TaskFailureClassification,
): void {
  if (!isMailTaskKind(task.kind)) return;
  const codeId =
    task.kind === "auth.login_code_email" ? loginCodeIdFromPayload(task.payloadJson) : undefined;
  logger.warn("email task dead-lettered", {
    taskId: task.id,
    kind: task.kind,
    attempts: task.attempts,
    classification,
    ...(codeId ? { codeId } : {}),
  });
}

function safeFailureMessage(kind: string, error: unknown): string {
  if (isMailTaskKind(kind)) return "Email delivery failed";
  return String(error);
}

type ClaimOptions = { lockToken?: string; leaseMs?: number };
type ClaimInternalOptions = ClaimOptions & { now?: Date };
export type ClaimOneTaskForClassOptions = ClaimOptions & { includeStale?: boolean };
type ClaimOneTaskForClassInternalOptions = ClaimOptions & { includeStale?: boolean };
export type ClaimedTaskForClass = Task & { reclaimedStale: boolean };

type NotificationDeliverPayload = {
  version: 1;
  userId?: string;
};

type RawTaskRow = {
  id: string;
  kind: string;
  dedupe_key: string | null;
  payload_json: unknown;
  run_after: Date;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  locked_by: string | null;
  lease_until: Date | null;
  last_error: string | null;
  priority: number;
  queue_class: TaskQueueClass;
  created_at: Date;
  updated_at: Date;
};

function rawTaskRowToTask(row: RawTaskRow, reclaimedStale: boolean): ClaimedTaskForClass {
  return {
    id: row.id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payloadJson: row.payload_json,
    runAfter: row.run_after,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    priority: row.priority,
    queueClass: row.queue_class,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reclaimedStale,
  };
}

async function sweepExpiredFinalAttemptTasksInternal(options: {
  now?: Date;
}): Promise<DeadLetterTask[]> {
  const clock = options.now;
  const updatedAt = clock ?? sql<Date>`now()`;
  const leaseExpired = clock ? lt(tasks.leaseUntil, clock) : sql`${tasks.leaseUntil} < now()`;

  const swept = await getDb().transaction(async (tx) => {
    const sweptTasks = await tx
      .update(tasks)
      .set({
        status: "dead",
        lockedAt: null,
        lockedBy: null,
        leaseUntil: null,
        lastError: "Task lease expired after the final execution attempt",
        updatedAt,
      })
      .where(
        and(
          eq(tasks.status, "processing"),
          leaseExpired,
          sql`${tasks.attempts} >= ${tasks.maxAttempts}`,
        ),
      )
      .returning({
        id: tasks.id,
        kind: tasks.kind,
        attempts: tasks.attempts,
        payloadJson: tasks.payloadJson,
      });

    const notificationTasks = sweptTasks.filter((task) => task.kind === "notification.deliver");
    if (notificationTasks.length === 0) return sweptTasks;

    const affectedDeliveries = await tx
      .update(notificationDeliveries)
      .set({
        status: "dead",
        lastOutcome: "lease_expired",
        lastError: "Task lease expired after the final execution attempt",
        nextAttemptAfter: null,
        updatedAt,
      })
      .where(
        and(
          inArray(
            notificationDeliveries.taskId,
            notificationTasks.map((task) => task.id),
          ),
          inArray(notificationDeliveries.status, ["queued", "sending", "deferred", "failed"]),
        ),
      )
      .returning({
        id: notificationDeliveries.id,
        campaignId: notificationDeliveries.campaignId,
        taskId: notificationDeliveries.taskId,
      });

    for (const delivery of affectedDeliveries) {
      const task = notificationTasks.find((candidate) => candidate.id === delivery.taskId);
      const payload = task?.payloadJson as NotificationDeliverPayload | null | undefined;
      const userId = typeof payload?.userId === "string" ? payload.userId : null;

      const [openAttempt] = await tx
        .select({ id: notificationDeliveryAttempts.id })
        .from(notificationDeliveryAttempts)
        .where(
          and(
            eq(notificationDeliveryAttempts.deliveryId, delivery.id),
            sql`${notificationDeliveryAttempts.completedAt} IS NULL`,
          ),
        )
        .orderBy(desc(notificationDeliveryAttempts.attemptNumber))
        .limit(1)
        .for("update");

      if (openAttempt) {
        await tx
          .update(notificationDeliveryAttempts)
          .set({
            outcome: "lease_expired",
            errorKind: "lease_expired",
            completedAt: updatedAt,
          })
          .where(eq(notificationDeliveryAttempts.id, openAttempt.id));
      } else if (userId) {
        // Reserve the synthetic attempt number by bumping attempt_count
        // atomically, keeping the delivery.attempt_count === latest
        // attempt_number ledger invariant that the finish-path fencing
        // relies on.
        const [deliveryState] = await tx
          .update(notificationDeliveries)
          .set({ attemptCount: sql`${notificationDeliveries.attemptCount} + 1` })
          .where(eq(notificationDeliveries.id, delivery.id))
          .returning({ attemptCount: notificationDeliveries.attemptCount });
        await tx.insert(notificationDeliveryAttempts).values({
          deliveryId: delivery.id,
          campaignId: delivery.campaignId,
          userId,
          taskId: delivery.taskId,
          attemptNumber: Math.max(1, deliveryState?.attemptCount ?? 1),
          attemptUtcDay: sql`(now() at time zone 'utc')::date`,
          attemptMinute: sql`date_trunc('minute', now())`,
          smtpAttempted: false,
          outcome: "lease_expired",
          errorKind: "lease_expired",
          completedAt: updatedAt,
        });
      }

      await tx
        .update(notificationCampaigns)
        .set({ status: "sending", updatedAt })
        .where(
          and(
            eq(notificationCampaigns.id, delivery.campaignId),
            inArray(notificationCampaigns.status, ["expanded", "sending"]),
          ),
        );
      await enqueueTask(tx, {
        kind: "notification.campaign_finalize",
        dedupeKey: `notification:campaign_finalize:${delivery.campaignId}`,
        payload: { version: 1, campaignId: delivery.campaignId },
        priority: 95,
        queueClass: "notification",
      });
    }

    return sweptTasks;
  });

  for (const task of swept) {
    warnMailTaskDeadLettered(task, "lease_expired");
  }
  return swept;
}

export async function sweepExpiredFinalAttemptTasks(): Promise<DeadLetterTask[]> {
  return sweepExpiredFinalAttemptTasksInternal({});
}

export async function sweepExpiredFinalAttemptTasksAt(now: Date): Promise<DeadLetterTask[]> {
  return sweepExpiredFinalAttemptTasksInternal({ now });
}

async function claimDueTasksInternal(
  limit: number,
  options: ClaimInternalOptions,
): Promise<Task[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const lockToken = options.lockToken ?? randomUUID();
  const leaseMs = options.leaseMs ?? TASK_LEASE_MS;
  const clock = options.now;
  const updatedAt = clock ?? sql<Date>`now()`;
  const leaseUntil = clock
    ? new Date(clock.getTime() + leaseMs)
    : sql<Date>`now() + (${leaseMs} * interval '1 millisecond')`;
  const leaseExpired = clock ? lt(tasks.leaseUntil, clock) : sql`${tasks.leaseUntil} < now()`;
  const dueToRun = clock ? lte(tasks.runAfter, clock) : sql`${tasks.runAfter} <= now()`;

  return getDb().transaction(async (tx) => {
    const staleProcessing = await tx
      .select({ id: tasks.id, runAfter: tasks.runAfter })
      .from(tasks)
      .where(
        and(
          sql`${tasks.attempts} < ${tasks.maxAttempts}`,
          eq(tasks.status, "processing"),
          leaseExpired,
        ),
      )
      .orderBy(asc(tasks.runAfter))
      .limit(limit)
      .for("update", { skipLocked: true });

    const remaining = limit - staleProcessing.length;
    const pendingOrFailed =
      remaining > 0
        ? await tx
            .select({ id: tasks.id, runAfter: tasks.runAfter })
            .from(tasks)
            .where(
              and(
                sql`${tasks.attempts} < ${tasks.maxAttempts}`,
                inArray(tasks.status, ["pending", "failed"]),
                dueToRun,
              ),
            )
            .orderBy(asc(tasks.runAfter))
            .limit(remaining)
            .for("update", { skipLocked: true })
        : [];

    // Branch priority is intentional: reclaim stale processing rows first,
    // then fill any remaining budget with due pending/failed rows. run_after
    // order is preserved within each branch, but not globally across branches.
    const selectedIds = Array.from(
      new Set([...staleProcessing, ...pendingOrFailed].map((row) => row.id)),
    );
    if (selectedIds.length === 0) return [];

    const claimed = await tx
      .update(tasks)
      .set({
        status: "processing",
        attempts: sql`${tasks.attempts} + 1`,
        lockedAt: updatedAt,
        lockedBy: lockToken,
        leaseUntil,
        updatedAt,
      })
      .where(inArray(tasks.id, selectedIds))
      .returning();

    const order = new Map(selectedIds.map((id, index) => [id, index]));
    return claimed.sort((left, right) => order.get(left.id)! - order.get(right.id)!);
  });
}

async function claimOneTaskForClassBranch(
  queueClass: TaskQueueClass,
  options: ClaimOneTaskForClassInternalOptions & { branch: "stale" | "due" },
): Promise<ClaimedTaskForClass | null> {
  const lockToken = options.lockToken ?? randomUUID();
  const leaseMs = options.leaseMs ?? TASK_LEASE_MS;
  return getDb().transaction(async (tx) => {
    if (options.branch === "stale") {
      const rows = await tx.execute(sql<RawTaskRow>`
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
            locked_by = ${lockToken},
            lease_until = now() + (${leaseMs} * interval '1 millisecond'),
            updated_at = now()
        FROM candidate
        WHERE tasks.id = candidate.id
        RETURNING tasks.*;
      `);
      const row = rows[0] as RawTaskRow | undefined;
      return row ? rawTaskRowToTask(row, true) : null;
    }

    const rows = await tx.execute(sql<RawTaskRow>`
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
          locked_by = ${lockToken},
          lease_until = now() + (${leaseMs} * interval '1 millisecond'),
          updated_at = now()
      FROM candidate
      WHERE tasks.id = candidate.id
      RETURNING tasks.*;
    `);
    const row = rows[0] as RawTaskRow | undefined;
    return row ? rawTaskRowToTask(row, false) : null;
  });
}

async function claimOneTaskForClassInternal(
  queueClass: TaskQueueClass,
  options: ClaimOneTaskForClassInternalOptions,
): Promise<ClaimedTaskForClass | null> {
  if (options.includeStale ?? true) {
    const stale = await claimOneTaskForClassBranch(queueClass, { ...options, branch: "stale" });
    if (stale) return stale;
  }
  return claimOneTaskForClassBranch(queueClass, { ...options, branch: "due" });
}

export async function claimOneTaskForClass(
  queueClass: TaskQueueClass,
  options: ClaimOneTaskForClassOptions = {},
): Promise<ClaimedTaskForClass | null> {
  return claimOneTaskForClassInternal(queueClass, options);
}

/** Production claim path. All due, lease and lock timestamps come from PostgreSQL. */
export async function claimDueTasks(limit: number, options: ClaimOptions = {}): Promise<Task[]> {
  return claimDueTasksInternal(limit, options);
}

/** Test-only deterministic clock path; production callers must use claimDueTasks(). */
export async function claimDueTasksAt(
  limit: number,
  now: Date,
  options: ClaimOptions = {},
): Promise<Task[]> {
  return claimDueTasksInternal(limit, { ...options, now });
}

export async function renewTaskLease(
  id: string,
  lockToken: string,
  leaseMs = TASK_LEASE_MS,
): Promise<boolean> {
  const [renewed] = await getDb()
    .update(tasks)
    .set({
      leaseUntil: sql`now() + (${leaseMs} * interval '1 millisecond')`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tasks.id, id), eq(tasks.status, "processing"), eq(tasks.lockedBy, lockToken)))
    .returning({ id: tasks.id });
  return Boolean(renewed);
}

export async function markTaskSucceeded(
  id: string,
  lockToken: string,
  note?: string | null,
): Promise<boolean> {
  const [updated] = await getDb()
    .update(tasks)
    .set({
      status: "succeeded",
      lockedAt: null,
      lockedBy: null,
      leaseUntil: null,
      lastError: note?.slice(0, TASK_ERROR_MAX_LENGTH) ?? null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tasks.id, id), eq(tasks.status, "processing"), eq(tasks.lockedBy, lockToken)))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export function taskBackoffMs(attempts: number): number {
  return 60_000 * 2 ** Math.max(0, attempts - 1);
}

async function markTaskFailedInternal(
  id: string,
  lockToken: string,
  error: unknown,
  now?: Date,
): Promise<TaskFinalizationResult> {
  const outcome = await getDb().transaction(async (tx) => {
    const ownership = and(
      eq(tasks.id, id),
      eq(tasks.status, "processing"),
      eq(tasks.lockedBy, lockToken),
    );
    const [task] = await tx.select().from(tasks).where(ownership).limit(1).for("update");
    if (!task) {
      return {
        result: { updated: false, status: null } as TaskFinalizationResult,
        deadLettered: null,
      };
    }
    const dead = task.attempts >= task.maxAttempts;
    const backoff = taskBackoffMs(task.attempts);
    const runAfter = dead
      ? task.runAfter
      : now
        ? new Date(now.getTime() + backoff)
        : sql<Date>`now() + (${backoff} * interval '1 millisecond')`;
    const [updated] = await tx
      .update(tasks)
      .set({
        status: dead ? "dead" : "failed",
        runAfter,
        lockedAt: null,
        lockedBy: null,
        leaseUntil: null,
        lastError: safeFailureMessage(task.kind, error).slice(0, TASK_ERROR_MAX_LENGTH),
        updatedAt: now ?? sql`now()`,
      })
      .where(ownership)
      .returning({ id: tasks.id });
    if (!updated) {
      return {
        result: { updated: false, status: null } as TaskFinalizationResult,
        deadLettered: null,
      };
    }
    return {
      result: { updated: true, status: dead ? "dead" : "failed" } as TaskFinalizationResult,
      deadLettered: dead ? task : null,
    };
  });

  if (outcome.deadLettered) {
    warnMailTaskDeadLettered(outcome.deadLettered, "transient");
  }
  return outcome.result;
}

/** Production failure path. Retry backoff is calculated by PostgreSQL. */
export async function markTaskFailed(
  id: string,
  lockToken: string,
  error: unknown,
): Promise<TaskFinalizationResult> {
  return markTaskFailedInternal(id, lockToken, error);
}

/** Test-only deterministic clock path. */
export async function markTaskFailedAt(
  id: string,
  lockToken: string,
  error: unknown,
  now: Date,
): Promise<TaskFinalizationResult> {
  return markTaskFailedInternal(id, lockToken, error, now);
}

export async function deferTask(id: string, lockToken: string, runAfter: Date): Promise<boolean> {
  const [updated] = await getDb()
    .update(tasks)
    .set({
      status: "pending",
      attempts: sql`greatest(${tasks.attempts} - 1, 0)`,
      runAfter,
      lockedAt: null,
      lockedBy: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tasks.id, id), eq(tasks.status, "processing"), eq(tasks.lockedBy, lockToken)))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export async function markTaskDead(
  id: string,
  lockToken: string,
  error: unknown,
): Promise<TaskFinalizationResult> {
  const safeError = error instanceof PermanentTaskError ? error.message : "Task failed permanently";
  const [updated] = await getDb()
    .update(tasks)
    .set({
      status: "dead",
      lockedAt: null,
      lockedBy: null,
      leaseUntil: null,
      lastError: safeError.slice(0, TASK_ERROR_MAX_LENGTH),
      updatedAt: sql`now()`,
    })
    .where(and(eq(tasks.id, id), eq(tasks.status, "processing"), eq(tasks.lockedBy, lockToken)))
    .returning({
      id: tasks.id,
      kind: tasks.kind,
      attempts: tasks.attempts,
      payloadJson: tasks.payloadJson,
    });
  if (!updated) return { updated: false, status: null };

  warnMailTaskDeadLettered(
    updated,
    error instanceof PermanentTaskError ? (error.classification ?? "permanent") : "permanent",
  );
  return { updated: true, status: "dead" };
}

export async function countMailTaskFailures(): Promise<MailTaskFailureCounts> {
  const [row] = await getDb()
    .select({
      businessFailed: sql<number>`count(*) filter (where ${tasks.kind} = ${"email"} and ${tasks.status} = ${"failed"})::int`,
      businessDead: sql<number>`count(*) filter (where ${tasks.kind} = ${"email"} and ${tasks.status} = ${"dead"})::int`,
      loginCodeFailed: sql<number>`count(*) filter (where ${tasks.kind} = ${"auth.login_code_email"} and ${tasks.status} = ${"failed"})::int`,
      loginCodeDead: sql<number>`count(*) filter (where ${tasks.kind} = ${"auth.login_code_email"} and ${tasks.status} = ${"dead"})::int`,
    })
    .from(tasks);

  return {
    businessEmail: {
      failed: Number(row?.businessFailed ?? 0),
      dead: Number(row?.businessDead ?? 0),
    },
    loginCodeEmail: {
      failed: Number(row?.loginCodeFailed ?? 0),
      dead: Number(row?.loginCodeDead ?? 0),
    },
  };
}

export async function listTasks(options: {
  status?: TaskStatus;
  limit?: number;
}): Promise<TaskAdminView[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const query = getDb()
    .select({
      id: tasks.id,
      kind: tasks.kind,
      status: tasks.status,
      attempts: tasks.attempts,
      maxAttempts: tasks.maxAttempts,
      runAfter: tasks.runAfter,
      lastError: tasks.lastError,
      createdAt: tasks.createdAt,
    })
    .from(tasks);
  return options.status
    ? query.where(eq(tasks.status, options.status)).orderBy(desc(tasks.createdAt)).limit(limit)
    : query.orderBy(desc(tasks.createdAt)).limit(limit);
}

const taskAdminSelection = {
  id: tasks.id,
  kind: tasks.kind,
  status: tasks.status,
  attempts: tasks.attempts,
  maxAttempts: tasks.maxAttempts,
  runAfter: tasks.runAfter,
  lastError: tasks.lastError,
  createdAt: tasks.createdAt,
};

const PAYMENT_PROVIDER_EVENT_DISPATCH_KIND = "payment_provider_event.dispatch";

export async function retryTask(id: string): Promise<TaskAdminView> {
  try {
    const retried = await getDb().transaction(async (tx) => {
      const [existing] = await tx
        .select({ kind: tasks.kind, payloadJson: tasks.payloadJson })
        .from(tasks)
        .where(eq(tasks.id, id))
        .limit(1);
      if (!existing) throw new ApiError(409, "taskNotRetryable");

      const eventRowId =
        existing.kind === PAYMENT_PROVIDER_EVENT_DISPATCH_KIND
          ? paymentProviderEventPayloadSchema.parse(existing.payloadJson).eventRowId
          : null;

      const [task] = await tx
        .update(tasks)
        .set({
          status: "pending",
          attempts: 0,
          runAfter: sql`now()`,
          lockedAt: null,
          lockedBy: null,
          leaseUntil: null,
          lastError: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(tasks.id, id), inArray(tasks.status, ["failed", "dead"])))
        .returning(taskAdminSelection);
      if (!task) throw new ApiError(409, "taskNotRetryable");

      if (eventRowId) {
        const [eventState] = await tx
          .select({ status: paymentProviderEvents.status })
          .from(paymentProviderEvents)
          .where(eq(paymentProviderEvents.id, eventRowId))
          .limit(1);
        if (!eventState) throw new ApiError(409, "taskNotRetryable");

        if (eventState.status === "processing") {
          // Do not steal processing rows, even with expired final-attempt leases: the next
          // dispatch execution safely terminalizes exhausted processing events, then a
          // second admin retry can revive them.
        }

        if (eventState.status === "failed" || eventState.status === "dead") {
          const [event] = await tx
            .update(paymentProviderEvents)
            .set({
              status: "received",
              // Manual admin retry intentionally restarts both failed and dead inbox rows.
              attempts: 0,
              lockedBy: null,
              leaseUntil: null,
              processedAt: null,
              error: null,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(paymentProviderEvents.id, eventRowId),
                inArray(paymentProviderEvents.status, ["dead", "failed"]),
              ),
            )
            .returning({ id: paymentProviderEvents.id });
          if (!event) throw new ApiError(409, "taskNotRetryable");
        }
      }

      return task;
    });
    return retried;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "taskNotRetryable");
  }
}
