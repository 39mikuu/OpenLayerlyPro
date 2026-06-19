import { NextRequest } from "next/server";

import { ApiError, handleApiError, jsonError, jsonOk } from "@/lib/api";
import { confirmAutoPayment } from "@/modules/payment";
import { getPaymentProvider } from "@/modules/payment/providers";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const provider = await getPaymentProvider("stripe");
    const event = await provider!.parseWebhook(
      await req.text(),
      req.headers.get("stripe-signature"),
    );
    if (event.type === "paid") await confirmAutoPayment("stripe", event);
    return jsonOk({ received: true });
  } catch (error) {
    if (error instanceof ApiError && error.code === "stripeConfigIncomplete") {
      return jsonError(503, error.code, error.params);
    }
    return handleApiError(error);
  }
}
