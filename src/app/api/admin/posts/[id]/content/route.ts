import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { savePublishedPostBody } from "@/modules/content";
import { MAX_POST_BODY_LENGTH, POST_JSON_MAX_BYTES } from "@/modules/content/markdown";

export const runtime = "nodejs";

const contentSchema = z
  .object({
    body: z.string().max(MAX_POST_BODY_LENGTH).nullable(),
  })
  .strict();

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { body } = await readJsonWithLimit(req, POST_JSON_MAX_BYTES, contentSchema);
    const { id } = await ctx.params;
    return jsonOk(await savePublishedPostBody(id, body));
  } catch (err) {
    return handleApiError(err);
  }
}
