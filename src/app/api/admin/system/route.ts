import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { getDashboardStats, getSystemStatus } from "@/modules/system/status";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    const [status, stats] = await Promise.all([getSystemStatus(), getDashboardStats()]);
    return jsonOk({ status, stats });
  } catch (err) {
    return handleApiError(err);
  }
}
