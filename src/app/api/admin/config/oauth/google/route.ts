import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearOAuthProviderConfig,
  getOAuthProviderAdminView,
  oauthProviderConfigSchema,
  saveOAuthProviderConfig,
} from "@/modules/config/oauth";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await getOAuthProviderAdminView("google"));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requireAdmin();
    const input = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      oauthProviderConfigSchema,
    );
    await saveOAuthProviderConfig("google", input);
    return jsonOk(await getOAuthProviderAdminView("google"));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    await clearOAuthProviderConfig("google");
    return jsonOk(await getOAuthProviderAdminView("google"));
  } catch (error) {
    return handleApiError(error);
  }
}
