import { NextRequest } from "next/server";

import { ApiError, handleApiError, jsonOk } from "@/lib/api";
import { parseAdminPageSize } from "@/modules/admin/pagination";
import { requireAdmin } from "@/modules/auth/session";
import { listPaymentRequestsPage } from "@/modules/payment";
import { serializePaymentRequestContainerForApi } from "@/modules/payment/rejection-note";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const statusParam = req.nextUrl.searchParams.get("status");
    const excludeStatusParam = req.nextUrl.searchParams.get("excludeStatus");
    const cursor = req.nextUrl.searchParams.get("cursor");
    const limit = parseAdminPageSize(req.nextUrl.searchParams.get("limit"));
    if (statusParam === "pending_review" && excludeStatusParam === null) {
      const page = await listPaymentRequestsPage({
        status: "pending_review",
        cursor,
        limit,
      });
      return jsonOk({
        ...page,
        items: page.items.map(serializePaymentRequestContainerForApi),
      });
    }
    if (statusParam === null && excludeStatusParam === "pending_review") {
      const page = await listPaymentRequestsPage({
        excludeStatus: "pending_review",
        cursor,
        limit,
      });
      return jsonOk({
        ...page,
        items: page.items.map(serializePaymentRequestContainerForApi),
      });
    }
    throw new ApiError(400, cursor ? "invalidCursor" : "invalidRequest");
  } catch (err) {
    return handleApiError(err);
  }
}
