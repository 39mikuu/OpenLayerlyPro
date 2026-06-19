import { handleApiError, jsonOk } from "@/lib/api";
import { revokeOtherSessions } from "@/modules/auth/admin-account";
import { requireAdminSession } from "@/modules/auth/session";

export const runtime = "nodejs";

export async function POST() {
  try {
    const { user, tokenHash } = await requireAdminSession();
    return jsonOk({ revoked: await revokeOtherSessions(user.id, tokenHash) });
  } catch (error) {
    return handleApiError(error);
  }
}
