import { NextRequest } from "next/server";
import { z } from "zod";

import { getClientIp, getUserAgent, handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { assertContentLengthWithinLimit, readJsonWithLimit } from "@/lib/request-body";
import { adminLogin } from "@/modules/auth/admin-login";
import { createSession, setSessionCookie } from "@/modules/auth/session";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const maxBytes = getEnv().REQUEST_JSON_MAX_BYTES;
    assertContentLengthWithinLimit(req, maxBytes);
    const ip = getClientIp(req) ?? "unknown";
    if (!rateLimit(`admin-login:${ip}`, 10, 10 * 60 * 1000)) {
      return jsonError(429, "requestRateLimited");
    }
    const { email, password } = await readJsonWithLimit(req, maxBytes, bodySchema);
    const user = await adminLogin(email, password);
    const { token, expiresAt } = await createSession(user.id, {
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });
    await setSessionCookie(token, expiresAt);
    return jsonOk({ id: user.id, email: user.email, role: user.role });
  } catch (err) {
    return handleApiError(err);
  }
}
