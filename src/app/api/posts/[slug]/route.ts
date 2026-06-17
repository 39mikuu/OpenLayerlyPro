import { NextRequest } from "next/server";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getCurrentUser } from "@/modules/auth/session";
import { canAccessPost, getPostBySlug, getRequiredTier, listPostFiles } from "@/modules/content";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const post = await getPostBySlug(slug);
    const user = await getCurrentUser();
    if (!post || (post.status !== "published" && user?.role !== "admin")) {
      return jsonError(404, "postNotFound");
    }
    const allowed = await canAccessPost(user, post);
    const requiredTier = await getRequiredTier(post);
    const meta = {
      id: post.id,
      title: post.title,
      slug: post.slug,
      summary: post.summary,
      coverFileId: post.coverFileId,
      visibility: post.visibility,
      requiredTier: requiredTier ? { name: requiredTier.name, level: requiredTier.level } : null,
      publishedAt: post.publishedAt,
      accessible: allowed,
    };
    if (!allowed) {
      return jsonOk({ ...meta, body: null, files: [] });
    }
    const files = await listPostFiles(post.id);
    return jsonOk({
      ...meta,
      body: post.body,
      files: files.map((f) => ({
        id: f.file.id,
        kind: f.link.kind,
        originalName: f.file.originalName,
        sizeBytes: f.file.sizeBytes,
        mimeType: f.file.mimeType,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
