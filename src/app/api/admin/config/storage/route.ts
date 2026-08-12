import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearStorageConfig,
  configClearSchema,
  configWriteEnvelopeSchema,
  getStorageAdminView,
  requireCurrentConfigRevision,
  requireWrittenRevision,
  saveStorageConfig,
  STORAGE_GROUP,
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
    const input = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      configWriteEnvelopeSchema,
    );
    const { revision } = input;
    await requireCurrentConfigRevision(STORAGE_GROUP, revision);
    const config = storageConfigSchema.parse(input);
    const writtenRevision = await saveStorageConfig(config, revision);
    return jsonOk(requireWrittenRevision(await getStorageAdminView(), writtenRevision));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin();
    const { revision } = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      configClearSchema,
    );
    const writtenRevision = await clearStorageConfig(revision);
    return jsonOk(requireWrittenRevision(await getStorageAdminView(), writtenRevision));
  } catch (err) {
    return handleApiError(err);
  }
}
