import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdminSession } from "@/modules/auth/session";
import { hideSupporterWallEntry } from "@/modules/supporter-wall";

export const runtime = "nodejs";

const bodySchema = z.object({
  expectedVersion: z.number().int().min(0),
});

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAdminSession();
    const body = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    const { id } = await context.params;
    return jsonOk(
      await hideSupporterWallEntry({
        id,
        expectedVersion: body.expectedVersion,
        actor: { type: "admin", id: user.id },
      }),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
