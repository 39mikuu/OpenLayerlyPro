import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearTurnstileConfig,
  configClearSchema,
  configWriteEnvelopeSchema,
  getTurnstileAdminView,
  requireCurrentConfigRevision,
  requireWrittenRevision,
  saveTurnstileConfig,
  TURNSTILE_GROUP,
  turnstileConfigSchema,
} from "@/modules/config";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await getTurnstileAdminView());
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
    await requireCurrentConfigRevision(TURNSTILE_GROUP, revision);
    const config = turnstileConfigSchema.parse(input);
    const writtenRevision = await saveTurnstileConfig(config, revision);
    return jsonOk(requireWrittenRevision(await getTurnstileAdminView(), writtenRevision));
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
    const writtenRevision = await clearTurnstileConfig(revision);
    return jsonOk(requireWrittenRevision(await getTurnstileAdminView(), writtenRevision));
  } catch (err) {
    return handleApiError(err);
  }
}
