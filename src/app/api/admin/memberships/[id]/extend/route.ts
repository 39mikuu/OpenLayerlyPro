import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { extendMembership } from "@/modules/membership";

export const runtime = "nodejs";

const bodySchema = z.object({
  days: z.number().int().min(1),
  expectedVersion: z.number().int().min(0),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    const { id } = await ctx.params;
    return jsonOk(
      await extendMembership(id, {
        ...input,
        actor: { type: "admin", id: admin.id },
      }),
    );
  } catch (err) {
    return handleApiError(err);
  }
}
