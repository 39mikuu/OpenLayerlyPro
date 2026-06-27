import { and, eq, inArray, not, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { paymentProviderEvents, tasks } from "@/db/schema";
import { enqueueTask } from "@/modules/tasks";

import type { NeutralizeReport } from "./types";

export const NEUTRALIZED_EMAIL_LAST_ERROR = "neutralized on restore: delivery outcome unknown";

const NON_TERMINAL_TASK_STATUSES = ["pending", "processing", "failed"] as const;
const NON_TERMINAL_PROVIDER_EVENT_STATUSES = ["received", "processing", "failed"] as const;
const EMAIL_TEMPLATES_TO_NEUTRALIZE = new Set([
  "membership_activated",
  "membership_revoked",
  "payment_rejected",
]);
const SUBSCRIPTION_RECONCILE_DEDUPE_KEY = "subscription.reconcile";

function emailTemplate(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const template = (payload as { template?: unknown }).template;
  return typeof template === "string" ? template : null;
}

export async function neutralizeRestoredTasks(db: DbClient = getDb()): Promise<NeutralizeReport> {
  return db.transaction(async (tx) => {
    const report: NeutralizeReport = {
      deletedStorageDeleteTasks: 0,
      providerEventsReset: 0,
      providerDispatchTasksEnsured: 0,
      emailRenewalRemindersReset: 0,
      emailDeliveryNeutralized: 0,
      otherTasksReset: 0,
      subscriptionReconcileNormalized: false,
    };

    const deletedStorageTasks = await tx
      .delete(tasks)
      .where(eq(tasks.kind, "storage.delete_object"))
      .returning({ id: tasks.id });
    report.deletedStorageDeleteTasks = deletedStorageTasks.length;

    const providerEvents = await tx
      .select()
      .from(paymentProviderEvents)
      .where(inArray(paymentProviderEvents.status, [...NON_TERMINAL_PROVIDER_EVENT_STATUSES]));

    for (const event of providerEvents) {
      await tx
        .update(paymentProviderEvents)
        .set({
          status: "received",
          lockedBy: null,
          leaseUntil: null,
          error: null,
          attempts: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(paymentProviderEvents.id, event.id));
      report.providerEventsReset += 1;

      const dedupeKey = `payment-provider-event:${event.id}`;
      await tx.delete(tasks).where(eq(tasks.dedupeKey, dedupeKey));
      await enqueueTask(tx, {
        kind: "payment_provider_event.dispatch",
        dedupeKey,
        payload: { eventRowId: event.id },
      });
      report.providerDispatchTasksEnsured += 1;
    }

    const nonTerminalEmailTasks = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.kind, "email"), inArray(tasks.status, [...NON_TERMINAL_TASK_STATUSES])));

    for (const task of nonTerminalEmailTasks) {
      const template = emailTemplate(task.payloadJson);
      if (template === "renewal_reminder") {
        const [updated] = await tx
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
          .where(eq(tasks.id, task.id))
          .returning({ id: tasks.id });
        if (updated) report.emailRenewalRemindersReset += 1;
        continue;
      }

      if (template && EMAIL_TEMPLATES_TO_NEUTRALIZE.has(template)) {
        const [updated] = await tx
          .update(tasks)
          .set({
            status: "dead",
            attempts: task.attempts,
            runAfter: sql`now()`,
            lockedAt: null,
            lockedBy: null,
            leaseUntil: null,
            lastError: NEUTRALIZED_EMAIL_LAST_ERROR,
            updatedAt: sql`now()`,
          })
          .where(eq(tasks.id, task.id))
          .returning({ id: tasks.id });
        if (updated) report.emailDeliveryNeutralized += 1;
        continue;
      }

      const [updatedOtherEmail] = await tx
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
        .where(eq(tasks.id, task.id))
        .returning({ id: tasks.id });
      if (updatedOtherEmail) report.otherTasksReset += 1;
    }

    const resetOtherTasks = await tx
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
      .where(
        and(
          inArray(tasks.status, [...NON_TERMINAL_TASK_STATUSES]),
          not(eq(tasks.kind, "email")),
          not(eq(tasks.kind, "storage.delete_object")),
          not(eq(tasks.kind, "subscription.reconcile")),
        ),
      )
      .returning({ id: tasks.id });
    report.otherTasksReset = resetOtherTasks.length;

    await tx.delete(tasks).where(eq(tasks.kind, "subscription.reconcile"));
    await enqueueTask(tx, {
      kind: "subscription.reconcile",
      dedupeKey: SUBSCRIPTION_RECONCILE_DEDUPE_KEY,
      payload: {},
    });
    report.subscriptionReconcileNormalized = true;

    return report;
  });
}

export function formatNeutralizeReport(report: NeutralizeReport): string {
  return JSON.stringify(report, null, 2);
}
