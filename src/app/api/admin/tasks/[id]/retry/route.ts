import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { retryTask } from "@/modules/tasks";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    return jsonOk(await retryTask(id));
  } catch (error) {
    return handleApiError(error);
  }
}
