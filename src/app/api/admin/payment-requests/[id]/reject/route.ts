import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimitOrDefault } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { rejectPaymentRequest } from "@/modules/payment";

export const runtime = "nodejs";

const bodySchema = z.object({
  reviewNote: z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { reviewNote } = await readJsonWithLimitOrDefault(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      bodySchema,
      {},
    );
    const { id } = await ctx.params;
    const updated = await rejectPaymentRequest(id, admin.id, reviewNote);
    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
