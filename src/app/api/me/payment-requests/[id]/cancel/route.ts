import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireUser } from "@/modules/auth/session";
import { cancelPaymentRequest } from "@/modules/payment";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await cancelPaymentRequest(id, user.id);
    return jsonOk({ cancelled: true });
  } catch (err) {
    return handleApiError(err);
  }
}
