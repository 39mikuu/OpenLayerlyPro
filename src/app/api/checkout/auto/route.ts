import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { requireUser } from "@/modules/auth/session";
import { createAutoCheckout } from "@/modules/payment";

export const runtime = "nodejs";

const bodySchema = z.object({ tierId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { tierId } = bodySchema.parse(await req.json());
    const appUrl = getEnv().APP_URL.replace(/\/$/, "");
    return jsonOk(
      await createAutoCheckout({
        userId: user.id,
        tierId,
        successUrl: `${appUrl}/me/orders?paid=1`,
        cancelUrl: `${appUrl}/checkout/${tierId}`,
      }),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
