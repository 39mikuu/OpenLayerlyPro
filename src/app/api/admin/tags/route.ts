import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { createTag, listTags } from "@/modules/taxonomy";

export const runtime = "nodejs";

const tagSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().max(100).optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await listTags());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
    return jsonOk(await createTag(tagSchema.parse(await request.json())));
  } catch (error) {
    return handleApiError(error);
  }
}
