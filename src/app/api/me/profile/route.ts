import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import { updateUserDisplayNameWithWallReset } from "@/modules/supporter-wall";

export const runtime = "nodejs";

const displayNameSchema = z.union([
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(50)),
  z.null(),
]);

const bodySchema = z.object({ displayName: displayNameSchema });

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const { displayName } = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      bodySchema,
    );
    await updateUserDisplayNameWithWallReset({ userId: user.id, displayName });
    return jsonOk({ displayName });
  } catch (err) {
    return handleApiError(err);
  }
}
