import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { parseAdminPageSize } from "@/modules/admin/pagination";
import { requireAdmin } from "@/modules/auth/session";
import { listPaymentRequestsPage } from "@/modules/payment";

export const runtime = "nodejs";

const STATUSES = [
  "pending_review",
  "pending_payment",
  "approved",
  "rejected",
  "cancelled",
  "reversed",
] as const;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const statusParam = req.nextUrl.searchParams.get("status");
    const status = STATUSES.includes(statusParam as (typeof STATUSES)[number])
      ? (statusParam as (typeof STATUSES)[number])
      : undefined;
    const excludeStatusParam = req.nextUrl.searchParams.get("excludeStatus");
    const excludeStatus = STATUSES.includes(excludeStatusParam as (typeof STATUSES)[number])
      ? (excludeStatusParam as (typeof STATUSES)[number])
      : undefined;
    return jsonOk(
      await listPaymentRequestsPage({
        status,
        excludeStatus,
        cursor: req.nextUrl.searchParams.get("cursor"),
        limit: parseAdminPageSize(req.nextUrl.searchParams.get("limit")),
      }),
    );
  } catch (err) {
    return handleApiError(err);
  }
}
