import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { deleteDraftTranslation } from "@/modules/content";

export const runtime = "nodejs";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; locale: string }> },
) {
  try {
    await requireAdmin();
    const { id, locale } = await ctx.params;
    await deleteDraftTranslation(id, locale);
    return jsonOk({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
