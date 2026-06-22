import { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError, handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { MAX_POST_BODY_LENGTH, renderMarkdown } from "@/modules/content/markdown";

export const runtime = "nodejs";

const PREVIEW_LIMIT = 60;
const PREVIEW_WINDOW_MS = 60_000;

const previewSchema = z.object({
  markdown: z.string().max(MAX_POST_BODY_LENGTH),
  embedMode: z.literal("preview"),
});

export async function POST(req: NextRequest) {
  try {
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, previewSchema);
    const admin = await requireAdmin();
    if (!rateLimit(`admin-markdown-preview:${admin.id}`, PREVIEW_LIMIT, PREVIEW_WINDOW_MS)) {
      throw new ApiError(429, "requestRateLimited");
    }

    return jsonOk(
      { html: renderMarkdown(input.markdown, { embedMode: input.embedMode }) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const response = handleApiError(err);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
