import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { revokeSession } from "@/modules/auth/admin-account";
import { clearSessionCookie, requireAdminSession } from "@/modules/auth/session";

export const runtime = "nodejs";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, tokenHash } = await requireAdminSession();
    const { id } = await ctx.params;
    const result = await revokeSession(user.id, id, tokenHash);
    if (result.current) await clearSessionCookie();
    return jsonOk({ revoked: true, current: result.current });
  } catch (error) {
    return handleApiError(error);
  }
}
