import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdminSession } from "@/modules/auth/session";
import { applySupporterWallSettingsUpdate } from "@/modules/supporter-wall";
import { SUPPORTER_WALL_MAX_MIN_LEVEL } from "@/modules/supporter-wall/constants";

export const runtime = "nodejs";

const bodySchema = z.object({
  enabled: z.boolean(),
  minLevel: z.union([z.number().int().min(0).max(SUPPORTER_WALL_MAX_MIN_LEVEL), z.null()]),
});

export async function PUT(req: NextRequest) {
  try {
    const { user } = await requireAdminSession();
    const body = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    return jsonOk(
      await applySupporterWallSettingsUpdate({
        enabled: body.enabled,
        minLevel: body.minLevel,
        actor: { type: "admin", id: user.id },
      }),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
