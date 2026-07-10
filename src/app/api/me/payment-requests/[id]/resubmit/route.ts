import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import { resubmitPaymentProof } from "@/modules/payment";
import { serializePaymentRequestForApi } from "@/modules/payment/rejection-note";

export const runtime = "nodejs";

const bodySchema = z.object({
  proofFileId: z.string().uuid(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { proofFileId } = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      bodySchema,
    );
    const { id } = await ctx.params;
    const updated = await resubmitPaymentProof({
      requestId: id,
      userId: user.id,
      proofFileId,
    });
    return jsonOk(serializePaymentRequestForApi(updated));
  } catch (err) {
    return handleApiError(err);
  }
}
