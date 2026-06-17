import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { unpublishTranslation } from "@/modules/content";

export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; locale: string }> },
) {
  try {
    await requireAdmin();
    const { id, locale } = await ctx.params;
    await unpublishTranslation(id, locale);
    return jsonOk({ unpublished: true });
  } catch (err) {
    return handleApiError(err);
  }
}
