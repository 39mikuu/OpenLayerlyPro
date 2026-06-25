import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { changeAdminPassword } from "@/modules/auth/admin-account";
import { requireAdminSession } from "@/modules/auth/session";

export const runtime = "nodejs";

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    const { user, tokenHash } = await requireAdminSession();
    return jsonOk(
      await changeAdminPassword(user.id, {
        ...input,
        currentTokenHash: tokenHash,
      }),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
