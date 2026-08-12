import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearOAuthProviderConfig,
  getOAuthProviderAdminView,
  oauthProviderConfigSchema,
  oauthProviderGroupKey,
  saveOAuthProviderConfig,
} from "@/modules/config/oauth";
import {
  configClearSchema,
  configWriteEnvelopeSchema,
  requireCurrentConfigRevision,
  requireWrittenRevision,
} from "@/modules/config/revision";

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
      configWriteEnvelopeSchema,
    );
    const { revision } = input;
    await requireCurrentConfigRevision(oauthProviderGroupKey("google"), revision);
    const config = oauthProviderConfigSchema.parse(input);
    const writtenRevision = await saveOAuthProviderConfig("google", config, revision);
    return jsonOk(
      requireWrittenRevision(await getOAuthProviderAdminView("google"), writtenRevision),
    );
  } catch (error) {
    return handleApiError(error);
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
    const writtenRevision = await clearOAuthProviderConfig("google", revision);
    return jsonOk(
      requireWrittenRevision(await getOAuthProviderAdminView("google"), writtenRevision),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
