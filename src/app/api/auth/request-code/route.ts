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
import { requestLoginCode } from "@/modules/auth/login-code";
import {
  getRequestCodePrimaryRateLimit,
  normalizeEmail,
  rawEmailSchema,
  validateNormalizedEmail,
} from "@/modules/auth/rate-limit-policy";
import { resolveLocale } from "@/modules/i18n/server";
import { assertTurnstile } from "@/modules/security/turnstile";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: rawEmailSchema,
  turnstileToken: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const env = getEnv();
    assertContentLengthWithinLimit(req, env.REQUEST_JSON_MAX_BYTES);
    const ip = getClientIp(req);
    const identity = resolveClientRateLimitIdentity(ip);
    if (identity.kind === "unresolved" && env.NODE_ENV === "production") {
      warnUnresolvedClientRateLimitIdentity({
        message:
          "Trusted client IP is unavailable for request-code. Using request-code-unresolved emergency rate-limit bucket.",
      });
    }
    const primaryLimit = getRequestCodePrimaryRateLimit(identity, env);
    if (!rateLimit(primaryLimit.key, primaryLimit.max, primaryLimit.windowMs)) {
      return jsonError(429, "requestRateLimited");
    }

    const { email, turnstileToken } = await readJsonWithLimit(
      req,
      env.REQUEST_JSON_MAX_BYTES,
      bodySchema,
    );
    const normalizedEmail = validateNormalizedEmail(normalizeEmail(email));
    // 人机验证失败时直接抛错，不会进入验证码发送逻辑
    await assertTurnstile(turnstileToken, ip);
    await requestLoginCode(normalizedEmail, {
      identity,
      ip,
      userAgent: getUserAgent(req),
      locale: await resolveLocale(),
    });
    return jsonOk({ accepted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
