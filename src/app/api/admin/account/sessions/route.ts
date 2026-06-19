import { handleApiError, jsonOk } from "@/lib/api";
import { listMySessions } from "@/modules/auth/admin-account";
import { requireAdminSession } from "@/modules/auth/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { user, tokenHash } = await requireAdminSession();
    return jsonOk(await listMySessions(user.id, tokenHash));
  } catch (error) {
    return handleApiError(error);
  }
}
