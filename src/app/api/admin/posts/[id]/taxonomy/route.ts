import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
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
    const { id } = await ctx.params;
    const taxonomy = bodySchema.parse(await request.json());
    await updatePostTaxonomy(id, taxonomy);
    return jsonOk({ updated: true });
  } catch (error) {
    return handleApiError(error);
  }
}
