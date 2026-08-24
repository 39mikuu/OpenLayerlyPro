import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { paymentProviderEvents, type Task, tasks } from "@/db/schema";
import { ApiError } from "@/lib/api";

import { paymentProviderEventPayloadSchema } from "./payloads";

export type TaskStatus = Task["status"];
export type TaskAdminView = Pick<
  Task,
  "id" | "kind" | "status" | "attempts" | "maxAttempts" | "runAfter" | "lastError" | "createdAt"
>;

export type MailTaskFailureCounts = {
  businessEmail: { failed: number; dead: number };
  loginCodeEmail: { failed: number; dead: number };
  magicLinkEmail: { failed: number; dead: number };
};

export async function countMailTaskFailures(): Promise<MailTaskFailureCounts> {
  const [row] = await getDb()
    .select({
      businessFailed: sql<number>`count(*) filter (where ${tasks.kind} = ${"email"} and ${tasks.status} = ${"failed"})::int`,
      businessDead: sql<number>`count(*) filter (where ${tasks.kind} = ${"email"} and ${tasks.status} = ${"dead"})::int`,
      loginCodeFailed: sql<number>`count(*) filter (where ${tasks.kind} = ${"auth.login_code_email"} and ${tasks.status} = ${"failed"})::int`,
      loginCodeDead: sql<number>`count(*) filter (where ${tasks.kind} = ${"auth.login_code_email"} and ${tasks.status} = ${"dead"})::int`,
      magicLinkFailed: sql<number>`count(*) filter (where ${tasks.kind} = ${"auth.magic_link_email"} and ${tasks.status} = ${"failed"})::int`,
      magicLinkDead: sql<number>`count(*) filter (where ${tasks.kind} = ${"auth.magic_link_email"} and ${tasks.status} = ${"dead"})::int`,
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
    magicLinkEmail: {
      failed: Number(row?.magicLinkFailed ?? 0),
      dead: Number(row?.magicLinkDead ?? 0),
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
