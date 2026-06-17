import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearSmtpConfig,
  getSmtpAdminView,
  saveSmtpConfig,
  smtpConfigSchema,
} from "@/modules/config";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await getSmtpAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requireAdmin();
    const input = smtpConfigSchema.parse(await req.json());
    await saveSmtpConfig(input);
    return jsonOk(await getSmtpAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    await clearSmtpConfig();
    return jsonOk(await getSmtpAdminView());
  } catch (err) {
    return handleApiError(err);
  }
}
