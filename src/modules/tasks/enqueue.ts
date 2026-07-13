import { sql } from "drizzle-orm";

import { type DbClient } from "@/db";
import { tasks } from "@/db/schema";

import { isTaskQueueClass, queueDefaultsForTaskKind, type TaskQueueClass } from "./queue-class";

export const DEFAULT_MAX_ATTEMPTS = 5;

export { queueDefaultsForTaskKind, type TaskQueueClass };

export async function enqueueTask(
  tx: DbClient,
  input: {
    id?: string;
    kind: string;
    dedupeKey?: string | null;
    payload: Record<string, unknown>;
    runAfter?: Date;
    maxAttempts?: number;
    priority?: number;
    queueClass?: TaskQueueClass;
  },
): Promise<void> {
  const defaults = queueDefaultsForTaskKind(input.kind);
  await tx
    .insert(tasks)
    .values({
      id: input.id,
      kind: input.kind,
      dedupeKey: input.dedupeKey ?? null,
      payloadJson: input.payload,
      runAfter: input.runAfter ?? sql`now()`,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      priority: input.priority ?? defaults.priority,
      queueClass: input.queueClass ?? defaults.queueClass,
    })
    .onConflictDoNothing({ target: tasks.dedupeKey });
}

export async function enqueueTaskReturningId(
  tx: DbClient,
  input: {
    id?: string;
    kind: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
    runAfter?: Date;
    maxAttempts?: number;
    priority?: number;
    queueClass?: TaskQueueClass;
  },
): Promise<string> {
  const defaults = queueDefaultsForTaskKind(input.kind);
  const [row] = await tx
    .insert(tasks)
    .values({
      id: input.id,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      payloadJson: input.payload,
      runAfter: input.runAfter ?? sql`now()`,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      priority: input.priority ?? defaults.priority,
      queueClass: input.queueClass ?? defaults.queueClass,
    })
    .onConflictDoNothing({ target: tasks.dedupeKey })
    .returning({ id: tasks.id });

  if (row) return row.id;

  const [existing] = await tx
    .select({ id: tasks.id, kind: tasks.kind, queueClass: tasks.queueClass })
    .from(tasks)
    .where(sql`${tasks.dedupeKey} = ${input.dedupeKey}`)
    .limit(1);

  if (!existing) {
    throw new Error("Task dedupe conflict did not return an existing task");
  }

  if (!isTaskQueueClass(existing.queueClass)) {
    throw new Error("Existing task has an invalid queue class");
  }

  return existing.id;
}
