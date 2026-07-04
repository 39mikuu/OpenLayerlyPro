import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { updatePostTaxonomy } from "@/modules/content";

export const runtime = "nodejs";

const bodySchema = z.object({
  categoryIds: z.array(z.string().uuid()),
  tagIds: z.array(z.string().uuid()),
});

export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const taxonomy = await readJsonWithLimit(request, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    const { id } = await ctx.params;
    await updatePostTaxonomy(id, taxonomy);
    return jsonOk({ updated: true });
  } catch (error) {
    return handleApiError(error);
  }
}
