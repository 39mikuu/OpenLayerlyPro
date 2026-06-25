import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import { createSubscriptionCheckout } from "@/modules/payment/subscriptions";

export const runtime = "nodejs";

const bodySchema = z.object({ tierId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const { tierId } = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    const user = await requireUser();
    const appUrl = getEnv().APP_URL.replace(/\/$/, "");
    return jsonOk(
      await createSubscriptionCheckout({
        userId: user.id,
        tierId,
        successUrl: `${appUrl}/me?subscribed=1`,
        cancelUrl: `${appUrl}/checkout/${tierId}`,
      }),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
