import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import {
  disableManualRenewalReminder,
  enableManualRenewalReminder,
} from "@/modules/membership/renewal-reminders";

export const runtime = "nodejs";

const bodySchema = z.object({
  tierId: z.string().uuid(),
  enabled: z.boolean(),
});

export async function PUT(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    if (body.enabled) {
      await enableManualRenewalReminder({ userId: user.id, tierId: body.tierId });
    } else {
      await disableManualRenewalReminder({ userId: user.id, tierId: body.tierId });
    }
    return jsonOk({ enabled: body.enabled });
  } catch (error) {
    return handleApiError(error);
  }
}
