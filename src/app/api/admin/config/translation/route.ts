import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearTranslationConfig,
  getTranslationAdminView,
  saveTranslationConfig,
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
    const input = translationConfigSchema.parse(await req.json());
    await saveTranslationConfig(input);
    return jsonOk(await getTranslationAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    await clearTranslationConfig();
    return jsonOk(await getTranslationAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}
