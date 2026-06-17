import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { grantMembership, listMemberships } from "@/modules/membership";
import { findOrCreateUserByEmail, findUserByEmail } from "@/modules/user";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await listMemberships());
  } catch (err) {
    return handleApiError(err);
  }
}

const bodySchema = z.object({
  userEmail: z.string().email(),
  tierId: z.string().uuid(),
  durationDays: z.number().int().min(1).optional(),
  note: z.string().max(500).nullable().optional(),
  createUserIfMissing: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const input = bodySchema.parse(await req.json());
    const user = input.createUserIfMissing
      ? await findOrCreateUserByEmail(input.userEmail)
      : await findUserByEmail(input.userEmail);
    if (!user) return jsonError(404, "userNotFound");
    const result = await grantMembership({
      userId: user.id,
      tierId: input.tierId,
      source: "manual",
      durationDays: input.durationDays,
      note: input.note,
      createdBy: admin.id,
    });
    return jsonOk(result);
  } catch (err) {
    return handleApiError(err);
  }
}
