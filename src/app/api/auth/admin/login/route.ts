import { NextRequest } from "next/server";
import { z } from "zod";

import { getClientIp, getUserAgent, handleApiError, jsonError, jsonOk } from "@/lib/api";
import {
  resolveClientRateLimitIdentity,
  warnUnresolvedClientRateLimitIdentity,
} from "@/lib/client-rate-limit";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { assertContentLengthWithinLimit, readJsonWithLimit } from "@/lib/request-body";
import { adminLogin } from "@/modules/auth/admin-login";
import {
  getAdminLoginRateLimit,
  normalizeEmail,
  rawEmailSchema,
  validateNormalizedEmail,
} from "@/modules/auth/rate-limit-policy";
import { createSession, setSessionCookie } from "@/modules/auth/session";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: rawEmailSchema,
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const maxBytes = getEnv().REQUEST_JSON_MAX_BYTES;
    assertContentLengthWithinLimit(req, maxBytes);
    const clientIp = getClientIp(req);
    const identity = resolveClientRateLimitIdentity(clientIp);
    const env = getEnv();
    if (identity.kind === "unresolved" && env.NODE_ENV === "production") {
      warnUnresolvedClientRateLimitIdentity({
        message:
          "Trusted client IP is unavailable for admin login. Using admin-login-unresolved emergency rate-limit bucket.",
      });
    }
    const limit = getAdminLoginRateLimit(identity, env);
    if (!rateLimit(limit.key, limit.max, limit.windowMs)) {
      return jsonError(429, "requestRateLimited");
    }
    const { email, password } = await readJsonWithLimit(req, maxBytes, bodySchema);
    const normalizedEmail = validateNormalizedEmail(normalizeEmail(email));
    const user = await adminLogin(normalizedEmail, password);
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
