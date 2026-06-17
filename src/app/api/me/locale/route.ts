import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireUser } from "@/modules/auth/session";
import { SUPPORTED_LOCALES } from "@/modules/i18n";
import { updateUserLocale } from "@/modules/user";

export const runtime = "nodejs";

const bodySchema = z.object({ locale: z.enum(SUPPORTED_LOCALES) });

export async function PUT(req: NextRequest) {
  try {
    const user = await requireUser();
    const { locale } = bodySchema.parse(await req.json());
    await updateUserLocale(user.id, locale);
    return jsonOk({ locale });
  } catch (err) {
    return handleApiError(err);
  }
}
