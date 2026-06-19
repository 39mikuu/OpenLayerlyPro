import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { changeAdminEmail } from "@/modules/auth/admin-account";
import { requireAdmin } from "@/modules/auth/session";

export const runtime = "nodejs";

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newEmail: z.string().email(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireAdmin();
    return jsonOk(await changeAdminEmail(user.id, bodySchema.parse(await req.json())));
  } catch (error) {
    return handleApiError(error);
  }
}
