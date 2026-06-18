import { z } from "zod";

import type { Task } from "@/db/schema";
import { getSmtpConfig } from "@/modules/config";
import { executeScheduledPublish } from "@/modules/content/publishing";
import { SUPPORTED_LOCALES } from "@/modules/i18n";
import { sendMembershipActivatedEmail, sendPaymentRejectedEmail } from "@/modules/mail";

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

export async function runTaskHandler(task: Task): Promise<TaskHandlerResult> {
  switch (task.kind) {
    case "email":
      return runEmailTask(task);
    case "publish_post":
      return runPublishPostTask(task);
    default:
      throw new PermanentTaskError("Unsupported task kind");
  }
}
