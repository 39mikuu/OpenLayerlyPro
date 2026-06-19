import { NextRequest } from "next/server";
import { z } from "zod";

import { getDb } from "@/db";
import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { setPostCategories, setPostTags } from "@/modules/taxonomy";

export const runtime = "nodejs";

const bodySchema = z.object({
  categoryIds: z.array(z.string().uuid()),
  tagIds: z.array(z.string().uuid()),
});

export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const { categoryIds, tagIds } = bodySchema.parse(await request.json());
    await getDb().transaction(async (tx) => {
      await setPostCategories(id, categoryIds, tx);
      await setPostTags(id, tagIds, tx);
    });
    return jsonOk({ updated: true });
  } catch (error) {
    return handleApiError(error);
  }
}
