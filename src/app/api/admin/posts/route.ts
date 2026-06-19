import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { createPost, listPosts } from "@/modules/content";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await listPosts());
  } catch (err) {
    return handleApiError(err);
  }
}

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/, "slug 只能包含小写字母、数字和连字符"),
  summary: z.string().max(1000).nullable().optional(),
  body: z.string().max(100000).nullable().optional(),
  coverFileId: z.string().uuid().nullable().optional(),
  visibility: z.enum(["public", "login", "member"]),
  requiredTierId: z.string().uuid().nullable().optional(),
  categoryIds: z.array(z.string().uuid()).default([]),
  tagIds: z.array(z.string().uuid()).default([]),
});

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const { categoryIds, tagIds, ...input } = bodySchema.parse(await req.json());
    return jsonOk(await createPost(input, { categoryIds, tagIds }));
  } catch (err) {
    return handleApiError(err);
  }
}
