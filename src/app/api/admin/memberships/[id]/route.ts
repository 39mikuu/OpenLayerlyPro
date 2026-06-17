import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { deleteMembership, updateMembership } from "@/modules/membership";

export const runtime = "nodejs";

const patchSchema = z.object({
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const input = patchSchema.parse(await req.json());
    const updated = await updateMembership(id, input);
    return jsonOk(updated);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    await deleteMembership(id);
    return jsonOk({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
