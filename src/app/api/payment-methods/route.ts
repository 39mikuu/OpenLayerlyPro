import { handleApiError, jsonOk } from "@/lib/api";
import { listPaymentMethods } from "@/modules/payment";

export const runtime = "nodejs";

export async function GET() {
  try {
    const methods = await listPaymentMethods({ activeOnly: true });
    return jsonOk(methods);
  } catch (err) {
    return handleApiError(err);
  }
}
