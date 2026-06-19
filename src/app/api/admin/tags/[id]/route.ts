import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { deleteTag, updateTag } from "@/modules/taxonomy";

export const runtime = "nodejs";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().max(100).optional(),
});

export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    return jsonOk(await updateTag(id, patchSchema.parse(await request.json())));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    await deleteTag(id);
    return jsonOk({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
