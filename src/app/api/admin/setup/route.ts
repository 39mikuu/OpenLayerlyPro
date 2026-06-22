import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { setupSite } from "@/modules/site";

export const runtime = "nodejs";

const bodySchema = z.object({
  siteName: z.string().min(1).max(100),
  artistName: z.string().min(1).max(100),
  artistBio: z.string().max(2000).default(""),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8, "密码至少 8 位"),
});

export async function POST(req: NextRequest) {
  try {
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    await setupSite(input);
    return jsonOk({ initialized: true });
  } catch (err) {
    return handleApiError(err);
  }
}
