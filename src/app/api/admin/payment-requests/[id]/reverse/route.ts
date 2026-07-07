import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimitOrDefault } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { reversePaymentApproval } from "@/modules/payment";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().max(500),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { reason } = await readJsonWithLimitOrDefault(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      bodySchema,
      {},
    );
    const { id } = await ctx.params;
    const updated = await reversePaymentApproval(id, admin.id, reason);
    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
