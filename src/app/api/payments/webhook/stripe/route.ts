import { NextRequest } from "next/server";

import { ApiError, handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readBoundedRawBody } from "@/lib/request-body";
import { confirmAutoPayment, expireAutoPayment, reverseAutoPayment } from "@/modules/payment";
import { getPaymentProvider } from "@/modules/payment/providers";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await readBoundedRawBody(req, getEnv().STRIPE_WEBHOOK_MAX_BYTES);
    const signature = req.headers.get("stripe-signature");
    if (!signature) throw new ApiError(401, "stripeSignatureInvalid");

    const provider = await getPaymentProvider("stripe");
    const event = await provider!.parseWebhook(rawBody, signature);
    if (event.type === "paid") await confirmAutoPayment("stripe", event);
    if (event.type === "expired") await expireAutoPayment("stripe", event);
    if (event.type === "refunded" || event.type === "disputed") {
      await reverseAutoPayment("stripe", event);
    }
    return jsonOk({ received: true });
  } catch (error) {
    if (error instanceof ApiError && error.code === "stripeConfigIncomplete") {
      return jsonError(503, error.code, error.params);
    }
    return handleApiError(error);
  }
}
