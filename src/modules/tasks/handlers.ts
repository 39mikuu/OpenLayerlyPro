import { z } from "zod";

import type { Task } from "@/db/schema";
import { getSmtpConfig } from "@/modules/config";
import { SUPPORTED_LOCALES } from "@/modules/i18n";
import { sendMembershipActivatedEmail, sendPaymentRejectedEmail } from "@/modules/mail";

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

export type TaskHandlerResult = { note?: string };

export async function runTaskHandler(task: Task): Promise<TaskHandlerResult> {
  if (task.kind !== "email") throw new Error(`Unsupported task kind: ${task.kind}`);
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
