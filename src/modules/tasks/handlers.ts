import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db";
import {
  memberships,
  membershipTiers,
  paymentRequests,
  subscriptions,
  type Task,
  users,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { deliverLoginCodeEmailTask } from "@/modules/auth/login-code";
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
  sendRenewalReminderEmail,
} from "@/modules/mail";
import { classifyMailError, MailDeliveryError } from "@/modules/mail/delivery";
import {
  handleRenewalReminder,
  shouldSendRenewalReminderEmail,
} from "@/modules/membership/renewal-reminders";
import {
  handleCampaignExpandTask,
  handleCampaignFinalizeTask,
  handleNotificationDeliveryTask,
} from "@/modules/notifications";
import { cleanupPaymentProof } from "@/modules/payment/proof-lifecycle";
import {
  dispatchPaymentProviderEvent,
  nextSubscriptionReconcileAt,
  reconcileSubscriptions,
} from "@/modules/payment/subscriptions";

import { PermanentTaskError } from "./errors";
import { paymentProviderEventPayloadSchema } from "./payloads";

const emailPayloadSchema = z.discriminatedUnion("template", [
  z.object({
    template: z.literal("membership_activated"),
    version: z.literal(2),
    paymentRequestId: z.string().uuid(),
    membershipId: z.string().uuid(),
  }),
  z.object({
    template: z.literal("membership_revoked"),
    version: z.literal(2),
    paymentRequestId: z.string().uuid(),
    membershipId: z.string().uuid(),
  }),
  z.object({
    template: z.literal("payment_rejected"),
    version: z.literal(2),
    paymentRequestId: z.string().uuid(),
    reviewedAt: z.string().datetime(),
  }),
  z.object({
    template: z.literal("renewal_reminder"),
    version: z.literal(2),
    subscriptionId: z.string().uuid(),
    periodEndsAt: z.string().datetime(),
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
const paymentProofCleanupPayloadSchema = z.object({
  requestId: z.string().uuid(),
  fileId: z.string().uuid(),
});
const renewalReminderPayloadSchema = z.object({
  subscriptionId: z.string().uuid(),
  periodEndsAt: z.string().datetime(),
});
const loginCodeEmailPayloadSchema = z.object({
  version: z.literal(1),
  codeId: z.string().uuid(),
  encryptedCode: z.string().min(1),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});

export type TaskHandlerResult = { note?: string; deferUntil?: Date };

const PROVIDER_EVENT_BUSY_DEFER_JITTER_MS = 250;

async function resolveMembershipEmail(input: {
  paymentRequestId: string;
  membershipId: string;
  expectedStatus: "approved" | "reversed";
}) {
  const [row] = await getDb()
    .select({
      request: paymentRequests,
      membership: memberships,
      user: users,
      tierName: membershipTiers.name,
    })
    .from(paymentRequests)
    .innerJoin(memberships, eq(memberships.id, input.membershipId))
    .innerJoin(users, eq(users.id, paymentRequests.userId))
    .innerJoin(membershipTiers, eq(membershipTiers.id, memberships.tierId))
    .where(eq(paymentRequests.id, input.paymentRequestId))
    .limit(1);

  if (
    !row ||
    row.request.status !== input.expectedStatus ||
    row.request.grantedMembershipId !== row.membership.id ||
    row.membership.id !== input.membershipId ||
    row.membership.userId !== row.request.userId
  ) {
    throw new PermanentTaskError("Transactional email domain reference is stale or missing");
  }

  return {
    to: row.user.email,
    locale: row.user.locale,
    tierName: row.tierName,
    endsAt: row.membership.endsAt,
  };
}

async function resolvePaymentRejectedEmail(input: { paymentRequestId: string; reviewedAt: Date }) {
  const [row] = await getDb()
    .select({
      request: paymentRequests,
      user: users,
      tierName: membershipTiers.name,
    })
    .from(paymentRequests)
    .innerJoin(users, eq(users.id, paymentRequests.userId))
    .innerJoin(membershipTiers, eq(membershipTiers.id, paymentRequests.tierId))
    .where(eq(paymentRequests.id, input.paymentRequestId))
    .limit(1);

  if (
    !row ||
    row.request.status !== "rejected" ||
    !row.request.reviewedAt ||
    row.request.reviewedAt.getTime() !== input.reviewedAt.getTime()
  ) {
    throw new PermanentTaskError("Transactional email domain reference is stale or missing");
  }

  return {
    to: row.user.email,
    locale: row.user.locale,
    tierName: row.tierName,
    reviewNote: row.request.reviewNote,
  };
}

async function resolveRenewalReminderEmail(input: {
  subscriptionId: string;
  periodEndsAt: Date;
}): Promise<
  | {
      kind: "send";
      to: string;
      locale: (typeof SUPPORTED_LOCALES)[number];
      tierName: string;
      endsAt: Date;
    }
  | { kind: "skip" }
> {
  const shouldSend = await shouldSendRenewalReminderEmail(input);
  if (!shouldSend) return { kind: "skip" };

  const [row] = await getDb()
    .select({
      subscription: subscriptions,
      user: users,
      tierName: membershipTiers.name,
    })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .innerJoin(membershipTiers, eq(membershipTiers.id, subscriptions.tierId))
    .where(
      and(
        eq(subscriptions.id, input.subscriptionId),
        eq(subscriptions.status, "active"),
        eq(subscriptions.currentPeriodEndsAt, input.periodEndsAt),
      ),
    )
    .limit(1);

  if (!row) return { kind: "skip" };
  return {
    kind: "send",
    to: row.user.email,
    locale: row.user.locale,
    tierName: row.tierName,
    endsAt: input.periodEndsAt,
  };
}

async function runEmailTask(task: Task): Promise<TaskHandlerResult> {
  const parsed = emailPayloadSchema.safeParse(task.payloadJson);
  if (!parsed.success) throw new PermanentTaskError("Invalid email payload");
  const payload = parsed.data;
  let deliver: () => Promise<void>;

  if (payload.template === "membership_activated") {
    const email = await resolveMembershipEmail({
      paymentRequestId: payload.paymentRequestId,
      membershipId: payload.membershipId,
      expectedStatus: "approved",
    });
    deliver = () =>
      sendMembershipActivatedEmail(email.to, email.tierName, email.endsAt, email.locale);
  } else if (payload.template === "membership_revoked") {
    const email = await resolveMembershipEmail({
      paymentRequestId: payload.paymentRequestId,
      membershipId: payload.membershipId,
      expectedStatus: "reversed",
    });
    deliver = () => sendMembershipRevokedEmail(email.to, email.tierName, email.locale);
  } else if (payload.template === "payment_rejected") {
    const email = await resolvePaymentRejectedEmail({
      paymentRequestId: payload.paymentRequestId,
      reviewedAt: new Date(payload.reviewedAt),
    });
    deliver = () =>
      sendPaymentRejectedEmail(email.to, email.tierName, email.reviewNote, email.locale);
  } else {
    const periodEndsAt = new Date(payload.periodEndsAt);
    const email = await resolveRenewalReminderEmail({
      subscriptionId: payload.subscriptionId,
      periodEndsAt,
    });
    if (email.kind === "skip")
      return { note: "Renewal reminder became inactive or stale; delivery skipped" };

    deliver = () => sendRenewalReminderEmail(email.to, email.tierName, email.endsAt, email.locale);
  }

  try {
    await deliver();
    return {};
  } catch (error) {
    const classification = classifyMailError(error);
    if (classification === "permanent") {
      throw new PermanentTaskError("Email delivery failed permanently", {
        classification,
      });
    }
    if (classification === "needs_operator") {
      const env = getEnv();
      const maxAgeMs = env.EMAIL_DELIVERY_MAX_AGE_HOURS * 60 * 60 * 1_000;
      if (Date.now() - task.createdAt.getTime() >= maxAgeMs) {
        throw new PermanentTaskError(
          `SMTP unavailable; email expired after ${env.EMAIL_DELIVERY_MAX_AGE_HOURS} h`,
          { classification },
        );
      }
      return {
        note: "SMTP unavailable; delivery deferred",
        deferUntil: new Date(Date.now() + env.EMAIL_RETRY_RECHECK_MINUTES * 60 * 1_000),
      };
    }

    // The transport already strips the provider error. Re-wrap here as well so
    // mocked/custom senders can never persist a raw recipient or message body.
    throw new MailDeliveryError("transient");
  }
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
    case "auth.login_code_email": {
      const parsed = loginCodeEmailPayloadSchema.safeParse(task.payloadJson);
      if (!parsed.success) throw new PermanentTaskError("Invalid auth.login_code_email payload");
      const note = await deliverLoginCodeEmailTask(parsed.data, {
        taskId: task.id,
        lockToken: task.lockedBy,
      });
      return note ? { note } : {};
    }
    case "email":
      return runEmailTask(task);
    case "publish_post":
      return runPublishPostTask(task);
    case "file.cleanup_orphan":
      return runCleanupOrphanTask(task);
    case "storage.delete_object":
      return runStorageDeleteTask(task);
    case "payment_proof.cleanup": {
      const parsed = paymentProofCleanupPayloadSchema.safeParse(task.payloadJson);
      if (!parsed.success) throw new PermanentTaskError("Invalid payment proof cleanup payload");
      return cleanupPaymentProof(parsed.data);
    }
    case "payment_provider_event.dispatch": {
      const parsed = paymentProviderEventPayloadSchema.safeParse(task.payloadJson);
      if (!parsed.success) throw new PermanentTaskError("Invalid payment provider event payload");
      try {
        await dispatchPaymentProviderEvent(parsed.data.eventRowId);
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 503 &&
          error.code === "paymentProviderEventBusy" &&
          typeof error.params?.leaseUntil === "string"
        ) {
          const leaseUntil = new Date(error.params.leaseUntil);
          if (!Number.isNaN(leaseUntil.getTime())) {
            return {
              deferUntil: new Date(leaseUntil.getTime() + PROVIDER_EVENT_BUSY_DEFER_JITTER_MS),
            };
          }
        }
        throw error;
      }
      return {};
    }
    case "subscription.renewal_reminder": {
      const parsed = renewalReminderPayloadSchema.safeParse(task.payloadJson);
      if (!parsed.success) throw new PermanentTaskError("Invalid renewal reminder payload");
      await handleRenewalReminder({
        subscriptionId: parsed.data.subscriptionId,
        periodEndsAt: new Date(parsed.data.periodEndsAt),
      });
      return {};
    }
    case "subscription.reconcile": {
      await reconcileSubscriptions();
      // Reuse the currently claimed, globally deduplicated row. The dispatcher
      // turns deferUntil into a pending task only after this successful run;
      // failures keep the normal durable-task retry/backoff semantics.
      return { deferUntil: nextSubscriptionReconcileAt() };
    }
    case "notification.campaign_expand":
      return handleCampaignExpandTask(task.payloadJson);
    case "notification.deliver":
      return handleNotificationDeliveryTask(task);
    case "notification.campaign_finalize":
      return handleCampaignFinalizeTask(task.payloadJson);
    default:
      throw new PermanentTaskError("Unsupported task kind");
  }
}
