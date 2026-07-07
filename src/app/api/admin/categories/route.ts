import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { createCategory, listCategories } from "@/modules/taxonomy";

export const runtime = "nodejs";

const categorySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().max(100).optional(),
  sortOrder: z.number().int().default(0),
});

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await listCategories());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
    const input = await readJsonWithLimit(request, getEnv().REQUEST_JSON_MAX_BYTES, categorySchema);
    return jsonOk(await createCategory(input));
  } catch (error) {
    return handleApiError(error);
  }
}
