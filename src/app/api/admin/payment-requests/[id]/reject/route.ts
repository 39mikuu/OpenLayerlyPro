import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { rejectPaymentRequest } from "@/modules/payment";

export const runtime = "nodejs";

const bodySchema = z.object({
  reviewNote: z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const { reviewNote } = bodySchema.parse(body);
    const updated = await rejectPaymentRequest(id, admin.id, reviewNote);
    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
