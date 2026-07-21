import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getClientIp, getUserAgent, handleApiError, jsonError } from "@/lib/api";
import {
  resolveClientRateLimitIdentity,
  warnUnresolvedClientRateLimitIdentity,
} from "@/lib/client-rate-limit";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { readFormDataWithLimit } from "@/lib/request-body";
import { consumeMagicLinkToken, RAW_MAGIC_LINK_TOKEN_MAX_LENGTH } from "@/modules/auth/magic-link";
import { getVerifyCodeCompareRateLimit } from "@/modules/auth/rate-limit-policy";
import { createSession, setSessionCookie } from "@/modules/auth/session";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import { resolveLocale } from "@/modules/i18n/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  token: z.string().min(1).max(RAW_MAGIC_LINK_TOKEN_MAX_LENGTH),
});

function tokenHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

function absoluteUrl(path: string): URL {
  // buildPublicUrl preserves an APP_URL path prefix (subpath deployments).
  return new URL(buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), path));
}

function resultUrl(status: "expired" | "replayed" | "invalid"): URL {
  const url = absoluteUrl("/login/magic/result");
  url.searchParams.set("status", status);
  return url;
}

export async function POST(req: NextRequest) {
  try {
    const env = getEnv();
    const clientIp = getClientIp(req);
    const identity = resolveClientRateLimitIdentity(clientIp);
    if (identity.kind === "unresolved" && env.NODE_ENV === "production") {
      warnUnresolvedClientRateLimitIdentity({
        message:
          "Trusted client IP is unavailable for magic-link confirm. Using verify-code-unresolved emergency rate-limit bucket.",
      });
    }
    // Shares the verify-code comparison budget: token confirmation attempts
    // spend the same per-source login-verification quota.
    const compareLimit = getVerifyCodeCompareRateLimit({ identity, env });
    if (!rateLimit(compareLimit.key, compareLimit.max, compareLimit.windowMs)) {
      const limited = jsonError(429, "codeAttemptsExceeded");
      for (const [key, value] of tokenHeaders()) limited.headers.set(key, value);
      return limited;
    }

    const form = await readFormDataWithLimit(req, env.REQUEST_JSON_MAX_BYTES);
    const { token } = bodySchema.parse({ token: form.get("token") });

    const result = await consumeMagicLinkToken(token, { locale: await resolveLocale() });
    if (result.status !== "consumed") {
      return NextResponse.redirect(resultUrl(result.status), {
        status: 303,
        headers: tokenHeaders(),
      });
    }

    const { token: sessionToken, expiresAt } = await createSession(result.user.id, {
      ip: clientIp,
      userAgent: getUserAgent(req),
    });
    await setSessionCookie(sessionToken, expiresAt);
    // Tokenless result redirect: the browser lands on the stored, validated
    // in-site path with neither the token nor the original query attached.
    return NextResponse.redirect(absoluteUrl(result.redirectPath ?? "/me"), {
      status: 303,
      headers: tokenHeaders(),
    });
  } catch (error) {
    const response = handleApiError(error);
    for (const [key, value] of tokenHeaders()) response.headers.set(key, value);
    return response;
  }
}
