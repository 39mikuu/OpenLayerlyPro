import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { savePublishedPostBody } from "@/modules/content";
import { MAX_POST_BODY_LENGTH } from "@/modules/content/markdown";

export const runtime = "nodejs";

const contentSchema = z
  .object({
    body: z.string().max(MAX_POST_BODY_LENGTH).nullable(),
  })
  .strict();

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const { body } = contentSchema.parse(await req.json());
    return jsonOk(await savePublishedPostBody(id, body));
  } catch (err) {
    return handleApiError(err);
  }
}
