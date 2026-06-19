import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { archivePost } from "@/modules/content";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    return jsonOk(await archivePost(id, { actor: { type: "admin", id: admin.id } }));
  } catch (err) {
    return handleApiError(err);
  }
}
