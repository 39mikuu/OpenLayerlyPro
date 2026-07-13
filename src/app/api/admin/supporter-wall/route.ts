import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { parseAdminPageSize } from "@/modules/admin/pagination";
import { requireAdminSession } from "@/modules/auth/session";
import { listSupporterWallEntriesPage } from "@/modules/supporter-wall";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();
    const cursor = req.nextUrl.searchParams.get("cursor");
    const limitValue = req.nextUrl.searchParams.get("limit");
    const limit = parseAdminPageSize(limitValue);
    return jsonOk(await listSupporterWallEntriesPage({ cursor, limit }));
  } catch (error) {
    return handleApiError(error);
  }
}
