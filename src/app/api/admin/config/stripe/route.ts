import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import {
  clearStripeConfig,
  getStripeAdminView,
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
    await saveStripeConfig(stripeConfigSchema.parse(await req.json()));
    return jsonOk(await getStripeAdminView());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE() {
  try {
    await requireAdmin();
    await clearStripeConfig();
    return jsonOk(await getStripeAdminView());
  } catch (error) {
    return handleApiError(error);
  }
}
