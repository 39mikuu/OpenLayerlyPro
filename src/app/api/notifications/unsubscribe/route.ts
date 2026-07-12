import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handleApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readFormDataWithLimit } from "@/lib/request-body";
import { unsubscribeNotificationToken } from "@/modules/notifications";

export const runtime = "nodejs";

const bodySchema = z.object({
  token: z.string().min(1).max(4096),
});

function resultUrl(status: string): URL {
  return new URL(
    `/unsubscribe/notifications/result?status=${encodeURIComponent(status)}`,
    getEnv().APP_URL,
  );
}

function tokenHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

export async function POST(req: NextRequest) {
  try {
    const form = await readFormDataWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES);
    const { token } = bodySchema.parse({ token: form.get("token") });
    const status = await unsubscribeNotificationToken(token);
    return NextResponse.redirect(resultUrl(status), { status: 303, headers: tokenHeaders() });
  } catch (error) {
    const response = handleApiError(error);
    for (const [key, value] of tokenHeaders()) response.headers.set(key, value);
    return response;
  }
}
