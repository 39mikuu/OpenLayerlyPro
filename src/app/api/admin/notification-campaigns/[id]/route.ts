import { NextRequest } from "next/server";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { getNotificationCampaignAdminSummary } from "@/modules/notifications/admin";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const summary = await getNotificationCampaignAdminSummary(id);
    if (!summary) return jsonError(404, "notificationCampaignNotFound");
    return jsonOk(summary);
  } catch (error) {
    return handleApiError(error);
  }
}
