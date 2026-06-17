import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
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
    await requireAdmin();
    const input = uploadConfigSchema.parse(await req.json());
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
