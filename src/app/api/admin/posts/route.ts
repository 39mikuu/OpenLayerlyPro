import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { createPost, listPosts } from "@/modules/content";
import { MAX_POST_BODY_LENGTH } from "@/modules/content/markdown";

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
  body: z.string().max(MAX_POST_BODY_LENGTH).nullable().optional(),
  coverFileId: z.string().uuid().nullable().optional(),
  visibility: z.enum(["public", "login", "member"]),
  requiredTierId: z.string().uuid().nullable().optional(),
  categoryIds: z.array(z.string().uuid()).default([]),
  tagIds: z.array(z.string().uuid()).default([]),
});

export async function POST(req: NextRequest) {
  try {
    const { categoryIds, tagIds, ...input } = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      bodySchema,
    );
    await requireAdmin();
    return jsonOk(await createPost(input, { categoryIds, tagIds }));
  } catch (err) {
    return handleApiError(err);
  }
}
