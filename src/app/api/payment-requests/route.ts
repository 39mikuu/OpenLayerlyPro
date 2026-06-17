import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireUser } from "@/modules/auth/session";
import { createPaymentRequest } from "@/modules/payment";

export const runtime = "nodejs";

const bodySchema = z.object({
  tierId: z.string().uuid(),
  paymentMethodId: z.string().uuid().nullable().optional(),
  proofFileId: z.string().uuid().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const input = bodySchema.parse(await req.json());
    const request = await createPaymentRequest({ userId: user.id, ...input });
    return jsonOk(request);
  } catch (err) {
    return handleApiError(err);
  }
}
