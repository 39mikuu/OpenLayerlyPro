import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import { requireBlogReaderAccess } from "@/modules/blog/access";
import { readerPath } from "@/modules/blog/paths";
import { createAutoCheckout } from "@/modules/payment";

export const runtime = "nodejs";

const bodySchema = z.object({ tierId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    await requireBlogReaderAccess(user);
    const { tierId } = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    const { APP_URL, PERSONAL_BLOG_MODE } = getEnv();
    const appUrl = APP_URL.replace(/\/$/, "");
    return jsonOk(
      await createAutoCheckout({
        userId: user.id,
        tierId,
        successUrl: `${appUrl}${readerPath("/me/orders", PERSONAL_BLOG_MODE)}?paid=1`,
        cancelUrl: `${appUrl}${readerPath(`/checkout/${tierId}`, PERSONAL_BLOG_MODE)}`,
      }),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
