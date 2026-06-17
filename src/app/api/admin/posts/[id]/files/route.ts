import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import {
  attachFileToPost,
  detachFileFromPost,
  getPostById,
  listPostFiles,
} from "@/modules/content";

export const runtime = "nodejs";

const attachSchema = z.object({
  fileId: z.string().uuid(),
  kind: z.enum(["cover", "image", "attachment", "preview", "thumbnail"]),
  sortOrder: z.number().int().default(0),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    if (!(await getPostById(id))) return jsonError(404, "postNotFound");
    const input = attachSchema.parse(await req.json());
    const link = await attachFileToPost({ postId: id, ...input });
    return jsonOk(link);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    return jsonOk(await listPostFiles(id));
  } catch (err) {
    return handleApiError(err);
  }
}

const detachSchema = z.object({
  fileId: z.string().uuid(),
});

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const { fileId } = detachSchema.parse(await req.json());
    await detachFileFromPost(id, fileId);
    return jsonOk({ detached: true });
  } catch (err) {
    return handleApiError(err);
  }
}
