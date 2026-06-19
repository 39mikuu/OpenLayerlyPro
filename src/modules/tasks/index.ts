import { randomUUID } from "crypto";
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { type Task, tasks } from "@/db/schema";
import { ApiError } from "@/lib/api";

import { PermanentTaskError } from "./errors";

export { PermanentTaskError };

// Total execution limit: failures 1-4 retry after 1m/2m/4m/8m; failure 5 is dead.
export const DEFAULT_MAX_ATTEMPTS = 5;
export const TASK_LEASE_MS = 60_000;
export const TASK_BATCH_SIZE = 20;
export const TASK_POLL_INTERVAL_MS = 10_000;
export const TASK_ERROR_MAX_LENGTH = 2_000;

export type TaskStatus = Task["status"];
export type TaskAdminView = Pick<
  Task,
  "id" | "kind" | "status" | "attempts" | "maxAttempts" | "runAfter" | "lastError" | "createdAt"
>;

export async function enqueueTask(
  tx: DbClient,
  input: {
    kind: string;
    dedupeKey?: string | null;
    payload: Record<string, unknown>;
    runAfter?: Date;
    maxAttempts?: number;
  },
): Promise<void> {
  await tx
    .insert(tasks)
    .values({
      kind: input.kind,
      dedupeKey: input.dedupeKey ?? null,
      payloadJson: input.payload,
      runAfter: input.runAfter ?? sql`now()`,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
    .onConflictDoNothing({ target: tasks.dedupeKey });
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

  return getDb().transaction(async (tx) => {
    // A crashed worker consumed its attempt when it claimed the task. Once the
    // final lease expires, recovery must not create an execution over the limit.
    await tx
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
      );

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
    if (due.length === 0) return [];

    return tx
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
  });
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
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const ownership = and(
      eq(tasks.id, id),
      eq(tasks.status, "processing"),
      eq(tasks.lockedBy, lockToken),
    );
    const [task] = await tx.select().from(tasks).where(ownership).limit(1).for("update");
    if (!task) return false;
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
        lastError: String(error).slice(0, TASK_ERROR_MAX_LENGTH),
        updatedAt: now ?? sql`now()`,
      })
      .where(ownership)
      .returning({ id: tasks.id });
    return Boolean(updated);
  });
}

/** Production failure path. Retry backoff is calculated by PostgreSQL. */
export async function markTaskFailed(
  id: string,
  lockToken: string,
  error: unknown,
): Promise<boolean> {
  return markTaskFailedInternal(id, lockToken, error);
}

/** Test-only deterministic clock path. */
export async function markTaskFailedAt(
  id: string,
  lockToken: string,
  error: unknown,
  now: Date,
): Promise<boolean> {
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
): Promise<boolean> {
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
    .returning({ id: tasks.id });
  return Boolean(updated);
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

export async function retryTask(id: string): Promise<TaskAdminView> {
  const [task] = await getDb()
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
  return task;
}
