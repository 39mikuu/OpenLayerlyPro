import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { approvePaymentRequest } from "@/modules/payment";
import { serializePaymentRequestForApi } from "@/modules/payment/rejection-note";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const updated = await approvePaymentRequest(id, admin.id);
    return jsonOk(serializePaymentRequestForApi(updated));
  } catch (err) {
    return handleApiError(err);
  }
}
