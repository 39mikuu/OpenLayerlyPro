import { handleApiError, jsonOk } from "@/lib/api";
import { requireUser } from "@/modules/auth/session";
import { listMyPaymentRequests } from "@/modules/payment";
import { serializePaymentRequestContainerForApi } from "@/modules/payment/rejection-note";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    return jsonOk(
      (await listMyPaymentRequests(user.id)).map(serializePaymentRequestContainerForApi),
    );
  } catch (err) {
    return handleApiError(err);
  }
}
