import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { parseAdminPageSize } from "@/modules/admin/pagination";
import { requireAdmin } from "@/modules/auth/session";
import { listFilesPage, listQuarantinedFilesPage } from "@/modules/file";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const quarantined = req.nextUrl.searchParams.get("quarantined");
    const options = {
      cursor: req.nextUrl.searchParams.get("cursor"),
      limit: parseAdminPageSize(req.nextUrl.searchParams.get("limit")),
    };
    if (quarantined === "true") return jsonOk(await listQuarantinedFilesPage(options));
    return jsonOk(await listFilesPage(options));
  } catch (err) {
    return handleApiError(err);
  }
}
