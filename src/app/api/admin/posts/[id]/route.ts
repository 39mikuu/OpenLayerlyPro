import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { deletePost, getPostById, listPostFiles, updatePost } from "@/modules/content";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const post = await getPostById(id);
    if (!post) return jsonError(404, "postNotFound");
    const files = await listPostFiles(id);
    return jsonOk({ post, files });
  } catch (err) {
    return handleApiError(err);
  }
}

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  summary: z.string().max(1000).nullable().optional(),
  body: z.string().max(100000).nullable().optional(),
  originalLocale: z.enum(["zh", "en", "ja"]).optional(),
  coverFileId: z.string().uuid().nullable().optional(),
  visibility: z.enum(["public", "login", "member"]).optional(),
  requiredTierId: z.string().uuid().nullable().optional(),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const input = patchSchema.parse(await req.json());
    return jsonOk(await updatePost(id, input));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    await deletePost(id);
    return jsonOk({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
