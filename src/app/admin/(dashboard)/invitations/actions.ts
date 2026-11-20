"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getEnv } from "@/lib/env";
import { normalizedEmailSchema, normalizeEmail } from "@/modules/auth/input-policy";
import { requireAdmin } from "@/modules/auth/session";
import { getBlogCopy } from "@/modules/blog/copy";
import { createReaderInvitation, revokeReaderInvitation } from "@/modules/blog/invitations";
import { resolveLocale } from "@/modules/i18n/server";
import { sendReaderInvitationEmail } from "@/modules/mail";

type InvitationFormState = { url?: string; error?: string; notice?: string };

export async function createInvitation(
  _state: InvitationFormState,
  data: FormData,
): Promise<InvitationFormState> {
  const user = await requireAdmin();
  if (!getEnv().PERSONAL_BLOG_MODE) notFound();
  const raw = data.get("email");
  const email = normalizedEmailSchema.safeParse(typeof raw === "string" ? normalizeEmail(raw) : "");
  const copy = getBlogCopy(await resolveLocale());
  if (!email.success) return { error: copy.invalidInvite };
  const token = await createReaderInvitation(email.data, user.id);
  const url = `${getEnv().APP_URL.replace(/\/+$/, "")}/inside/invite/${token}`;
  let notice: string | undefined;
  if (data.get("send") === "on") {
    try {
      await sendReaderInvitationEmail({
        email: email.data,
        link: url,
        subject: copy.inviteHeading,
        instructions: copy.inviteHint,
      });
      notice = copy.mailSent;
    } catch {
      notice = copy.mailFailed;
    }
  }
  revalidatePath("/admin/invitations");
  return { url, notice };
}

export async function revokeInvitation(id: string) {
  const user = await requireAdmin();
  if (!getEnv().PERSONAL_BLOG_MODE) notFound();
  if (!z.uuid().safeParse(id).success) return;
  await revokeReaderInvitation(id, user.id);
  revalidatePath("/admin/invitations");
}
