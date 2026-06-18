import { randomUUID } from "crypto";
import { and, asc, desc, eq, inArray, lt, lte, or } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { type Task, tasks } from "@/db/schema";
import { ApiError } from "@/lib/api";

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
      runAfter: input.runAfter ?? new Date(),
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
    .onConflictDoNothing({ target: tasks.dedupeKey });
}

export async function claimDueTasks(
  limit: number,
  options: { lockToken?: string; now?: Date; leaseMs?: number } = {},
): Promise<Task[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const now = options.now ?? new Date();
  const lockToken = options.lockToken ?? randomUUID();
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? TASK_LEASE_MS));

  return getDb().transaction(async (tx) => {
    const due = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        or(
          and(inArray(tasks.status, ["pending", "failed"]), lte(tasks.runAfter, now)),
          and(eq(tasks.status, "processing"), lt(tasks.leaseUntil, now)),
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
        lockedAt: now,
        lockedBy: lockToken,
        leaseUntil,
        updatedAt: now,
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

export async function renewTaskLease(
  id: string,
  lockToken: string,
  leaseMs = TASK_LEASE_MS,
): Promise<boolean> {
  const now = new Date();
  const [renewed] = await getDb()
    .update(tasks)
    .set({
      leaseUntil: new Date(now.getTime() + leaseMs),
      updatedAt: now,
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
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, id), eq(tasks.status, "processing"), eq(tasks.lockedBy, lockToken)))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export function taskBackoffMs(attempts: number): number {
  return 60_000 * 2 ** Math.max(0, attempts - 1);
}

export async function markTaskFailed(
  id: string,
  lockToken: string,
  error: unknown,
  now = new Date(),
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const ownership = and(
      eq(tasks.id, id),
      eq(tasks.status, "processing"),
      eq(tasks.lockedBy, lockToken),
    );
    const [task] = await tx.select().from(tasks).where(ownership).limit(1).for("update");
    if (!task) return false;
    const attempts = task.attempts + 1;
    const dead = attempts >= task.maxAttempts;
    const [updated] = await tx
      .update(tasks)
      .set({
        attempts,
        status: dead ? "dead" : "failed",
        runAfter: dead ? task.runAfter : new Date(now.getTime() + taskBackoffMs(attempts)),
        lockedAt: null,
        lockedBy: null,
        leaseUntil: null,
        lastError: String(error).slice(0, TASK_ERROR_MAX_LENGTH),
        updatedAt: now,
      })
      .where(ownership)
      .returning({ id: tasks.id });
    return Boolean(updated);
  });
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
  const now = new Date();
  const [task] = await getDb()
    .update(tasks)
    .set({
      status: "pending",
      attempts: 0,
      runAfter: now,
      lockedAt: null,
      lockedBy: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: now,
    })
    .where(and(eq(tasks.id, id), inArray(tasks.status, ["failed", "dead"])))
    .returning(taskAdminSelection);
  if (!task) throw new ApiError(409, "taskNotRetryable");
  return task;
}
