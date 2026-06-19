import { handleApiError, jsonOk } from "@/lib/api";
import { listAdminAuditHistory } from "@/modules/auth/admin-account";
import { requireAdmin } from "@/modules/auth/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireAdmin();
    return jsonOk(await listAdminAuditHistory(user.id));
  } catch (error) {
    return handleApiError(error);
  }
}
