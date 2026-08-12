import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearStripeConfig,
  configClearSchema,
  expectedRevisionSchema,
  getStripeAdminView,
  requireWrittenRevision,
  saveStripeConfig,
  stripeConfigSchema,
} from "@/modules/config";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await getStripeAdminView());
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
      stripeConfigSchema.extend({ revision: expectedRevisionSchema }),
    );
    const { revision, ...config } = input;
    const writtenRevision = await saveStripeConfig(config, revision);
    return jsonOk(requireWrittenRevision(await getStripeAdminView(), writtenRevision));
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
    const writtenRevision = await clearStripeConfig(revision);
    return jsonOk(requireWrittenRevision(await getStripeAdminView(), writtenRevision));
  } catch (error) {
    return handleApiError(error);
  }
}
