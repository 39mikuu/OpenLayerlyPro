import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
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
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    const user = await requireUser();
    const request = await createPaymentRequest({ userId: user.id, ...input });
    return jsonOk(request);
  } catch (err) {
    return handleApiError(err);
  }
}
