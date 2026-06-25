import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearUploadConfig,
  getUploadAdminView,
  saveUploadConfig,
  uploadConfigSchema,
} from "@/modules/config";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await getUploadAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, uploadConfigSchema);
    await requireAdmin();
    await saveUploadConfig(input);
    return jsonOk(await getUploadAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    await clearUploadConfig();
    return jsonOk(await getUploadAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}
