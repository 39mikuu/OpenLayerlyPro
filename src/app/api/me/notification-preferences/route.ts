import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import { getNotificationPreference, setNotificationPreference } from "@/modules/notifications";

export const runtime = "nodejs";

const bodySchema = z.object({
  newPostEmailEnabled: z.boolean(),
});

export async function GET() {
  try {
    const user = await requireUser();
    return jsonOk(await getNotificationPreference(user.id));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    return jsonOk(
      await setNotificationPreference({
        userId: user.id,
        newPostEmailEnabled: body.newPostEmailEnabled,
      }),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
