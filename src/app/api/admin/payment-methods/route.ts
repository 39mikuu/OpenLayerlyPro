import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { createPaymentMethod, listPaymentMethods } from "@/modules/payment";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await listPaymentMethods());
  } catch (err) {
    return handleApiError(err);
  }
}

const bodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).nullable().optional(),
  qrFileId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export async function POST(req: NextRequest) {
  try {
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    await requireAdmin();
    return jsonOk(await createPaymentMethod(input));
  } catch (err) {
    return handleApiError(err);
  }
}
