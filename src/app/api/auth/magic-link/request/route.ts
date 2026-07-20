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
import {
  MAGIC_LINK_REDIRECT_MAX_LENGTH,
  normalizeMagicLinkRedirectPath,
  requestMagicLink,
} from "@/modules/auth/magic-link";
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
  next: z.string().max(MAGIC_LINK_REDIRECT_MAX_LENGTH).optional(),
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
          "Trusted client IP is unavailable for magic-link request. Using request-code-unresolved emergency rate-limit bucket.",
      });
    }
    // Shares the request-code source budget: both flows spend the same
    // outbound auth-email quota per source.
    const primaryLimit = getRequestCodePrimaryRateLimit(identity, env);
    if (!rateLimit(primaryLimit.key, primaryLimit.max, primaryLimit.windowMs)) {
      return jsonError(429, "requestRateLimited");
    }

    const { email, turnstileToken, next } = await readJsonWithLimit(
      req,
      env.REQUEST_JSON_MAX_BYTES,
      bodySchema,
    );
    const normalizedEmail = validateNormalizedEmail(normalizeEmail(email));
    // 人机验证失败时直接抛错，不会进入 Magic Link 发送逻辑
    await assertTurnstile(turnstileToken, ip);
    await requestMagicLink(normalizedEmail, {
      identity,
      ip,
      userAgent: getUserAgent(req),
      locale: await resolveLocale(),
      redirectPath: normalizeMagicLinkRedirectPath(next),
    });
    // Anti-enumeration: existing and unknown mailboxes, sent and suppressed
    // requests all collapse into the same accepted response.
    return jsonOk({ accepted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
