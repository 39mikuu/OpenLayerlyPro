import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { deleteCategory, updateCategory } from "@/modules/taxonomy";

export const runtime = "nodejs";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().max(100).optional(),
  sortOrder: z.number().int().optional(),
});

export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const input = await readJsonWithLimit(request, getEnv().REQUEST_JSON_MAX_BYTES, patchSchema);
    await requireAdmin();
    const { id } = await ctx.params;
    return jsonOk(await updateCategory(id, input));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    await deleteCategory(id);
    return jsonOk({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
