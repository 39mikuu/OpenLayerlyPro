import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { generateAiTranslationDraft } from "@/modules/translation/ai-draft";

export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; locale: string }> },
) {
  try {
    await requireAdmin();
    const { id, locale } = await ctx.params;
    const translation = await generateAiTranslationDraft(id, locale);
    return jsonOk(translation);
  } catch (err) {
    return handleApiError(err);
  }
}
