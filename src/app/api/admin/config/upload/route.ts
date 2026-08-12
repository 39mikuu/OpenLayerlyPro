import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearUploadConfig,
  configClearSchema,
  expectedRevisionSchema,
  getUploadAdminView,
  requireWrittenRevision,
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
    const input = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      uploadConfigSchema.extend({ revision: expectedRevisionSchema }),
    );
    const { revision, ...config } = input;
    const writtenRevision = await saveUploadConfig(config, revision);
    return jsonOk(requireWrittenRevision(await getUploadAdminView(), writtenRevision));
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
    const writtenRevision = await clearUploadConfig(revision);
    return jsonOk(requireWrittenRevision(await getUploadAdminView(), writtenRevision));
  } catch (err) {
    return handleApiError(err);
  }
}
