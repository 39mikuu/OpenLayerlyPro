import { and, eq, inArray, not, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import {
  notificationCampaigns,
  notificationDeliveries,
  paymentProviderEvents,
  tasks,
} from "@/db/schema";
import { enqueueTask } from "@/modules/tasks/enqueue";

import type { NeutralizeReport } from "./types";

export const NEUTRALIZED_EMAIL_LAST_ERROR = "neutralized on restore: delivery outcome unknown";
export const NEUTRALIZED_NOTIFICATION_LAST_ERROR =
  "neutralized on restore: notification delivery outcome unknown";

const NON_TERMINAL_TASK_STATUSES = ["pending", "processing", "failed"] as const;
const NON_TERMINAL_PROVIDER_EVENT_STATUSES = ["received", "processing", "failed"] as const;
const NOTIFICATION_TASK_KINDS = [
  "notification.deliver",
  "notification.campaign_expand",
  "notification.campaign_finalize",
] as const;
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

function redactedEmailPayload(payload: unknown): Record<string, unknown> {
  const template = emailTemplate(payload) ?? "unknown";
  const version =
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { version?: unknown }).version === "number"
      ? (payload as { version: number }).version
      : 1;
  return { version, template, recipientRedacted: true };
}

function hasRenewalReminderV2Reference(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as {
    version?: unknown;
    template?: unknown;
    subscriptionId?: unknown;
    periodEndsAt?: unknown;
  };
  return (
    candidate.version === 2 &&
    candidate.template === "renewal_reminder" &&
    typeof candidate.subscriptionId === "string" &&
    typeof candidate.periodEndsAt === "string"
  );
}

function campaignIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const campaignId = (payload as { campaignId?: unknown }).campaignId;
  return typeof campaignId === "string" ? campaignId : null;
}

export async function neutralizeRestoredTasks(db: DbClient = getDb()): Promise<NeutralizeReport> {
  return db.transaction(async (tx) => {
    const report: NeutralizeReport = {
      deletedStorageDeleteTasks: 0,
      providerEventsReset: 0,
      providerDispatchTasksEnsured: 0,
      emailRenewalRemindersReset: 0,
      emailDeliveryNeutralized: 0,
      notificationTasksNeutralized: 0,
      notificationDeliveriesNeutralized: 0,
      notificationCampaignsNeutralized: 0,
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
        if (!hasRenewalReminderV2Reference(task.payloadJson)) {
          const [updated] = await tx
            .update(tasks)
            .set({
              status: "dead",
              runAfter: sql`now()`,
              lockedAt: null,
              lockedBy: null,
              leaseUntil: null,
              lastError: NEUTRALIZED_EMAIL_LAST_ERROR,
              payloadJson: redactedEmailPayload(task.payloadJson),
              updatedAt: sql`now()`,
            })
            .where(eq(tasks.id, task.id))
            .returning({ id: tasks.id });
          if (updated) report.emailDeliveryNeutralized += 1;
          continue;
        }
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
            payloadJson: redactedEmailPayload(task.payloadJson),
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

    const nonTerminalNotificationTasks = await tx
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.kind, [...NOTIFICATION_TASK_KINDS]),
          inArray(tasks.status, [...NON_TERMINAL_TASK_STATUSES]),
        ),
      );

    for (const task of nonTerminalNotificationTasks) {
      const campaignId = campaignIdFromPayload(task.payloadJson);
      const [updated] = await tx
        .update(tasks)
        .set({
          status: "dead",
          runAfter: sql`now()`,
          lockedAt: null,
          lockedBy: null,
          leaseUntil: null,
          lastError: NEUTRALIZED_NOTIFICATION_LAST_ERROR,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, task.id))
        .returning({ id: tasks.id });
      if (updated) report.notificationTasksNeutralized += 1;

      if (task.kind === "notification.deliver") {
        const deliveryRows = await tx
          .update(notificationDeliveries)
          .set({
            status: "dead",
            lastError: NEUTRALIZED_NOTIFICATION_LAST_ERROR,
            updatedAt: sql`now()`,
          })
          .where(eq(notificationDeliveries.taskId, task.id))
          .returning({ campaignId: notificationDeliveries.campaignId });
        report.notificationDeliveriesNeutralized += deliveryRows.length;
        for (const delivery of deliveryRows) {
          const [campaign] = await tx
            .update(notificationCampaigns)
            .set({
              status: "dead",
              lastError: NEUTRALIZED_NOTIFICATION_LAST_ERROR,
              updatedAt: sql`now()`,
            })
            .where(eq(notificationCampaigns.id, delivery.campaignId))
            .returning({ id: notificationCampaigns.id });
          if (campaign) report.notificationCampaignsNeutralized += 1;
        }
        continue;
      }

      if (campaignId) {
        const [campaign] = await tx
          .update(notificationCampaigns)
          .set({
            status: "dead",
            lastError: NEUTRALIZED_NOTIFICATION_LAST_ERROR,
            updatedAt: sql`now()`,
          })
          .where(eq(notificationCampaigns.id, campaignId))
          .returning({ id: notificationCampaigns.id });
        if (campaign) report.notificationCampaignsNeutralized += 1;
      }
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
          not(inArray(tasks.kind, [...NOTIFICATION_TASK_KINDS])),
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
