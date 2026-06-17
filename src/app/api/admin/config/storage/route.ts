import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearStorageConfig,
  getStorageAdminView,
  saveStorageConfig,
  storageConfigSchema,
} from "@/modules/config";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await getStorageAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requireAdmin();
    const input = storageConfigSchema.parse(await req.json());
    await saveStorageConfig(input);
    return jsonOk(await getStorageAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    await clearStorageConfig();
    return jsonOk(await getStorageAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}
