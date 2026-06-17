import { handleApiError, jsonOk } from "@/lib/api";
import { destroyCurrentSession } from "@/modules/auth/session";

export const runtime = "nodejs";

export async function POST() {
  try {
    await destroyCurrentSession();
    return jsonOk({ loggedOut: true });
  } catch (err) {
    return handleApiError(err);
  }
}
