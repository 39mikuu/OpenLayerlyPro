import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { listPaymentRequests } from "@/modules/payment";

export const runtime = "nodejs";

const STATUSES = ["pending_review", "approved", "rejected", "cancelled", "reversed"] as const;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const statusParam = req.nextUrl.searchParams.get("status");
    const status = STATUSES.includes(statusParam as (typeof STATUSES)[number])
      ? (statusParam as (typeof STATUSES)[number])
      : undefined;
    return jsonOk(await listPaymentRequests(status));
  } catch (err) {
    return handleApiError(err);
  }
}
