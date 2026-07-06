import { randomUUID } from "crypto";
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { paymentProviderEvents, type Task, tasks } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { logger } from "@/lib/logger";

import { DEFAULT_MAX_ATTEMPTS, enqueueTask } from "./enqueue";
import { PermanentTaskError, type TaskFailureClassification } from "./errors";
import { paymentProviderEventPayloadSchema } from "./payloads";

export { DEFAULT_MAX_ATTEMPTS, enqueueTask, PermanentTaskError };

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

type DeadLetterTask = Pick<Task, "id" | "kind" | "attempts" | "payloadJson">;

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

  const outcome = await getDb().transaction(async (tx) => {
    // A crashed worker consumed its attempt when it claimed the task. Once the
    // final lease expires, recovery must not create an execution over the limit.
    const swept = await tx
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

    const due = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          sql`${tasks.attempts} < ${tasks.maxAttempts}`,
          or(
            and(inArray(tasks.status, ["pending", "failed"]), dueToRun),
            and(eq(tasks.status, "processing"), leaseExpired),
          ),
        ),
      )
      .orderBy(asc(tasks.runAfter))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return { claimed: [] as Task[], swept };

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
      .where(
        inArray(
          tasks.id,
          due.map((row) => row.id),
        ),
      )
      .returning();
    return { claimed, swept };
  });

  for (const task of outcome.swept) {
    warnMailTaskDeadLettered(task, "lease_expired");
  }
  return outcome.claimed;
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
          // Do not steal processing rows, even with expired final-attempt leases: the next claim
          // safely terminalizes exhausted processing events, then a second admin retry can revive them.
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
