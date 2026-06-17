import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { getPostById, listPostTranslations, upsertDraftTranslation } from "@/modules/content";
import { SUPPORTED_LOCALES } from "@/modules/i18n";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const post = await getPostById(id);
    if (!post) return jsonError(404, "postNotFound");
    const translations = await listPostTranslations(id);
    return jsonOk({
      post: {
        id: post.id,
        originalLocale: post.originalLocale,
        title: post.title,
        summary: post.summary,
        body: post.body,
        updatedAt: post.updatedAt,
      },
      availableLocales: SUPPORTED_LOCALES.filter((locale) => locale !== post.originalLocale),
      translations,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const bodySchema = z.object({
  locale: z.string(),
  title: z.string().max(200),
  summary: z.string().max(1000).nullable().optional(),
  body: z.string().max(100000).nullable().optional(),
  source: z.enum(["manual", "machine"]).optional(),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const input = bodySchema.parse(await req.json());
    const translation = await upsertDraftTranslation(id, input.locale, {
      title: input.title,
      summary: input.summary,
      body: input.body,
      source: input.source ?? "manual",
    });
    return jsonOk(translation);
  } catch (err) {
    return handleApiError(err);
  }
}
