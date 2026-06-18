import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { suspendMembership } from "@/modules/membership";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().min(0),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const input = bodySchema.parse(await req.json());
    return jsonOk(
      await suspendMembership(id, {
        ...input,
        actor: { type: "admin", id: admin.id },
      }),
    );
  } catch (err) {
    return handleApiError(err);
  }
}
