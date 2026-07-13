import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { listNotificationCampaignAdminSummaries } from "@/modules/notifications/admin";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await listNotificationCampaignAdminSummaries());
  } catch (error) {
    return handleApiError(error);
  }
}
