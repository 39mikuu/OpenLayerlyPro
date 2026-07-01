import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearTurnstileConfig,
  getTurnstileAdminView,
  saveTurnstileConfig,
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
      turnstileConfigSchema,
    );
    await saveTurnstileConfig(input);
    return jsonOk(await getTurnstileAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    await clearTurnstileConfig();
    return jsonOk(await getTurnstileAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}
