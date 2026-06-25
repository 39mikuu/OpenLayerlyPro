import { z } from "zod";

import type { Task } from "@/db/schema";
import { getSmtpConfig } from "@/modules/config";
import { executeScheduledPublish } from "@/modules/content/publishing";
import {
  cleanupOrphanFile,
  deleteStorageObject,
  UnsupportedOrphanCleanupPurposeError,
} from "@/modules/file/cleanup";
import { SUPPORTED_LOCALES } from "@/modules/i18n";
import {
  sendMembershipActivatedEmail,
  sendMembershipRevokedEmail,
  sendPaymentRejectedEmail,
} from "@/modules/mail";
import {
  dispatchPaymentProviderEvent,
  nextSubscriptionReconcileAt,
  reconcileSubscriptions,
} from "@/modules/payment/subscriptions";

import { PermanentTaskError } from "./errors";

const emailPayloadSchema = z.discriminatedUnion("template", [
  z.object({
    template: z.literal("membership_activated"),
    to: z.string().email(),
    locale: z.enum(SUPPORTED_LOCALES),
    params: z.object({
      tierName: z.string(),
      endsAt: z.string().datetime(),
    }),
  }),
  z.object({
    template: z.literal("membership_revoked"),
    to: z.string().email(),
    locale: z.enum(SUPPORTED_LOCALES),
    params: z.object({
      tierName: z.string(),
    }),
  }),
  z.object({
    template: z.literal("payment_rejected"),
    to: z.string().email(),
    locale: z.enum(SUPPORTED_LOCALES),
    params: z.object({
      tierName: z.string(),
      reviewNote: z.string().nullable(),
    }),
  }),
]);

const publishPostPayloadSchema = z.object({
  postId: z.string().uuid(),
  scheduleToken: z.string().uuid(),
  correlationId: z.string().uuid(),
  schedulingAuditId: z.string().uuid(),
});

const cleanupOrphanPayloadSchema = z.object({ fileId: z.string().uuid() });
const storageDeletePayloadSchema = z.object({
  storageDriver: z.enum(["local", "s3"]),
  bucket: z.string().nullable(),
  objectKey: z.string().min(1),
});
const paymentProviderEventPayloadSchema = z.object({ eventRowId: z.string().uuid() });

export type TaskHandlerResult = { note?: string; deferUntil?: Date };

async function runEmailTask(task: Task): Promise<TaskHandlerResult> {
  const payload = emailPayloadSchema.parse(task.payloadJson);
  const smtp = await getSmtpConfig();
  if (!smtp.configured) return { note: "SMTP not configured; delivery skipped" };

  if (payload.template === "membership_activated") {
    await sendMembershipActivatedEmail(
      payload.to,
      payload.params.tierName,
      new Date(payload.params.endsAt),
      payload.locale,
    );
  } else if (payload.template === "membership_revoked") {
    await sendMembershipRevokedEmail(payload.to, payload.params.tierName, payload.locale);
  } else {
    await sendPaymentRejectedEmail(
      payload.to,
      payload.params.tierName,
      payload.params.reviewNote,
      payload.locale,
    );
  }
  return {};
}

async function runPublishPostTask(task: Task): Promise<TaskHandlerResult> {
  const parsed = publishPostPayloadSchema.safeParse(task.payloadJson);
  if (!parsed.success) {
    throw new PermanentTaskError("Invalid publish_post payload");
  }

  const result = await executeScheduledPublish(parsed.data);
  if (result.outcome === "defer") {
    return { note: result.note, deferUntil: result.deferUntil };
  }
  return { note: result.note };
}

async function runCleanupOrphanTask(task: Task): Promise<TaskHandlerResult> {
  const parsed = cleanupOrphanPayloadSchema.safeParse(task.payloadJson);
  if (!parsed.success) throw new PermanentTaskError("Invalid file.cleanup_orphan payload");
  try {
    const outcome = await cleanupOrphanFile(parsed.data.fileId);
    return { note: `Orphan cleanup ${outcome}` };
  } catch (error) {
    if (error instanceof UnsupportedOrphanCleanupPurposeError) {
      throw new PermanentTaskError(error.message);
    }
    throw error;
  }
}

async function runStorageDeleteTask(task: Task): Promise<TaskHandlerResult> {
  const parsed = storageDeletePayloadSchema.safeParse(task.payloadJson);
  if (!parsed.success) throw new PermanentTaskError("Invalid storage.delete_object payload");
  await deleteStorageObject(parsed.data);
  return {};
}

export async function runTaskHandler(task: Task): Promise<TaskHandlerResult> {
  switch (task.kind) {
    case "email":
      return runEmailTask(task);
    case "publish_post":
      return runPublishPostTask(task);
    case "file.cleanup_orphan":
      return runCleanupOrphanTask(task);
    case "storage.delete_object":
      return runStorageDeleteTask(task);
    case "payment_provider_event.dispatch": {
      const parsed = paymentProviderEventPayloadSchema.safeParse(task.payloadJson);
      if (!parsed.success) throw new PermanentTaskError("Invalid payment provider event payload");
      await dispatchPaymentProviderEvent(parsed.data.eventRowId);
      return {};
    }
    case "subscription.reconcile": {
      await reconcileSubscriptions();
      // Reuse the currently claimed, globally deduplicated row. The dispatcher
      // turns deferUntil into a pending task only after this successful run;
      // failures keep the normal durable-task retry/backoff semantics.
      return { deferUntil: nextSubscriptionReconcileAt() };
    }
    default:
      throw new PermanentTaskError("Unsupported task kind");
  }
}
