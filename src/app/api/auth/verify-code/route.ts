import { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError, getClientIp, getUserAgent, handleApiError, jsonError, jsonOk } from "@/lib/api";
import {
  resolveClientRateLimitIdentity,
  warnUnresolvedClientRateLimitIdentity,
} from "@/lib/client-rate-limit";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { assertContentLengthWithinLimit, readJsonWithLimit } from "@/lib/request-body";
import { verifyLoginCode } from "@/modules/auth/login-code";
import {
  getVerifyCodeCompareRateLimit,
  getVerifyCodeWrongAttemptRateLimits,
  normalizeEmail,
  normalizeLoginCode,
  RAW_LOGIN_CODE_MAX_LENGTH,
  rawEmailSchema,
  validateLoginCode,
  validateNormalizedEmail,
} from "@/modules/auth/rate-limit-policy";
import { createSession, setSessionCookie } from "@/modules/auth/session";
import { resolveLocale } from "@/modules/i18n/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: rawEmailSchema,
  code: z.string().min(1).max(RAW_LOGIN_CODE_MAX_LENGTH),
});

export async function POST(req: NextRequest) {
  try {
    const env = getEnv();
    assertContentLengthWithinLimit(req, env.REQUEST_JSON_MAX_BYTES);
    const { email, code } = await readJsonWithLimit(req, env.REQUEST_JSON_MAX_BYTES, bodySchema);
    const normalizedEmail = validateNormalizedEmail(normalizeEmail(email));
    const normalizedCode = validateLoginCode(normalizeLoginCode(code), env);

    const clientIp = getClientIp(req);
    const identity = resolveClientRateLimitIdentity(clientIp);
    if (identity.kind === "unresolved" && env.NODE_ENV === "production") {
      warnUnresolvedClientRateLimitIdentity({
        message:
          "Trusted client IP is unavailable for verify-code. Using verify-code-unresolved emergency rate-limit bucket.",
      });
    }

    // Hard source budget: no target email is present in this key, so a remote
    // attacker cannot lock a victim account while still being prevented from
    // triggering unlimited real code comparisons from one client identity.
    const compareLimit = getVerifyCodeCompareRateLimit({ identity, env });
    if (!rateLimit(compareLimit.key, compareLimit.max, compareLimit.windowMs)) {
      return jsonError(429, "codeAttemptsExceeded");
    }

    const locale = await resolveLocale();
    let user: Awaited<ReturnType<typeof verifyLoginCode>>;
    try {
      user = await verifyLoginCode(normalizedEmail, normalizedCode, locale);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "codeIncorrect" || error.code === "codeExpired")
      ) {
        // Additional target-scoped accounting remains post-comparison so a
        // third party cannot pre-fill an email bucket and lock out the owner.
        const limits = getVerifyCodeWrongAttemptRateLimits({
          identity,
          normalizedEmail,
          env,
        });
        const allowed = limits.map((limit) => rateLimit(limit.key, limit.max, limit.windowMs));
        if (allowed.some((value) => !value)) {
          return jsonError(429, "codeAttemptsExceeded");
        }
      }
      throw error;
    }

    const { token, expiresAt } = await createSession(user.id, {
      ip: clientIp,
      userAgent: getUserAgent(req),
    });
    await setSessionCookie(token, expiresAt);
    return jsonOk({ id: user.id, email: user.email, role: user.role });
  } catch (err) {
    return handleApiError(err);
  }
}
