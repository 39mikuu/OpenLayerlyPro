import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { reversePaymentApproval } from "@/modules/payment";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().max(500),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const { reason } = bodySchema.parse(body);
    const updated = await reversePaymentApproval(id, admin.id, reason);
    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
