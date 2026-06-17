import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireUser } from "@/modules/auth/session";
import { resubmitPaymentProof } from "@/modules/payment";

export const runtime = "nodejs";

const bodySchema = z.object({
  proofFileId: z.string().uuid(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const { proofFileId } = bodySchema.parse(await req.json());
    const updated = await resubmitPaymentProof({
      requestId: id,
      userId: user.id,
      proofFileId,
    });
    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
