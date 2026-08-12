import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearTranslationConfig,
  configClearSchema,
  configWriteEnvelopeSchema,
  getTranslationAdminView,
  requireCurrentConfigRevision,
  requireWrittenRevision,
  saveTranslationConfig,
  TRANSLATION_GROUP,
  translationConfigSchema,
} from "@/modules/config";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await getTranslationAdminView());
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
    await requireCurrentConfigRevision(TRANSLATION_GROUP, revision);
    const config = translationConfigSchema.parse(input);
    const writtenRevision = await saveTranslationConfig(config, revision);
    return jsonOk(requireWrittenRevision(await getTranslationAdminView(), writtenRevision));
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
    const writtenRevision = await clearTranslationConfig(revision);
    return jsonOk(requireWrittenRevision(await getTranslationAdminView(), writtenRevision));
  } catch (err) {
    return handleApiError(err);
  }
}
