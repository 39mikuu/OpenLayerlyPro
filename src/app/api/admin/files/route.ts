import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { listFiles, listQuarantinedFiles } from "@/modules/file";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const quarantined = req.nextUrl.searchParams.get("quarantined");
    if (quarantined === "true") return jsonOk(await listQuarantinedFiles());
    return jsonOk(await listFiles());
  } catch (err) {
    return handleApiError(err);
  }
}
