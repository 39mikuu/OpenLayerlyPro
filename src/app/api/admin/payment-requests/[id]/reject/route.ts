import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimitOrDefault } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { rejectPaymentRequest } from "@/modules/payment";
import {
  PAYMENT_REJECT_REASON_CODES,
  serializePaymentRequestForApi,
} from "@/modules/payment/rejection-note";

export const runtime = "nodejs";

const bodySchema = z.object({
  rejectReasonCode: z.enum(PAYMENT_REJECT_REASON_CODES).optional(),
  rejectDetails: z.string().max(400).nullable().optional(),
  reviewNote: z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { rejectReasonCode, rejectDetails, reviewNote } = await readJsonWithLimitOrDefault(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      bodySchema,
      {},
    );
    const { id } = await ctx.params;
    const updated = await rejectPaymentRequest(
      id,
      admin.id,
      rejectReasonCode ? { rejectReasonCode, rejectDetails } : { reviewNote },
    );
    return jsonOk(serializePaymentRequestForApi(updated));
  } catch (err) {
    return handleApiError(err);
  }
}
