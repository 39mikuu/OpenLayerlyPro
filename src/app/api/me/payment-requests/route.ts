import { handleApiError, jsonOk } from "@/lib/api";
import { requireUser } from "@/modules/auth/session";
import { listMyPaymentRequests } from "@/modules/payment";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    return jsonOk(await listMyPaymentRequests(user.id));
  } catch (err) {
    return handleApiError(err);
  }
}
