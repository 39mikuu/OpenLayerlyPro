import { NextRequest, NextResponse } from "next/server";

import { handleApiError } from "@/lib/api";
import { readBoundedRawBody } from "@/lib/request-body";
import { unsubscribeNotificationToken } from "@/modules/notifications";

export const runtime = "nodejs";

const UNSUBSCRIBE_BODY_MAX_BYTES = 1024;

function tokenHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

export async function POST(req: NextRequest, context: { params: Promise<{ token: string }> }) {
  try {
    await readBoundedRawBody(req, UNSUBSCRIBE_BODY_MAX_BYTES);
    const { token } = await context.params;
    const result = await unsubscribeNotificationToken(token);
    if (req.headers.get("accept")?.includes("application/json")) {
      return NextResponse.json(
        { ok: result !== "invalid", status: result },
        { status: result === "invalid" ? 400 : 200, headers: tokenHeaders() },
      );
    }
    return new NextResponse(null, {
      status: result === "invalid" ? 400 : 204,
      headers: tokenHeaders(),
    });
  } catch (error) {
    const response = handleApiError(error);
    for (const [key, value] of tokenHeaders()) response.headers.set(key, value);
    return response;
  }
}
