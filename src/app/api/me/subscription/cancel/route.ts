import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import { cancelMySubscription } from "@/modules/payment/subscriptions";

export const runtime = "nodejs";

const bodySchema = z.object({ subscriptionId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { subscriptionId } = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      bodySchema,
    );
    return jsonOk(await cancelMySubscription({ userId: user.id, subscriptionId }));
  } catch (error) {
    return handleApiError(error);
  }
}
