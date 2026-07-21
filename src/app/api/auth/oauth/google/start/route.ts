import { NextRequest, NextResponse } from "next/server";

import { getClientIp, getUserAgent, handleApiError } from "@/lib/api";
import { resolveClientRateLimitIdentity } from "@/lib/client-rate-limit";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeMagicLinkRedirectPath } from "@/modules/auth/magic-link";
import {
  beginOAuthLogin,
  getOAuthBrowserBindingCookie,
  getOAuthCookiePath,
  OAUTH_STATE_TTL_MINUTES,
} from "@/modules/auth/oauth";
import { getOAuthStartRateLimit } from "@/modules/auth/rate-limit-policy";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";

export const runtime = "nodejs";

function absoluteUrl(path: string): URL {
  return new URL(buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), path));
}

function rateLimitedRedirect(): NextResponse {
  const url = absoluteUrl("/login");
  url.searchParams.set("oauth_error", "rate_limited");
  return NextResponse.redirect(url, { status: 303 });
}

export async function GET(req: NextRequest) {
  try {
    const env = getEnv();
    const ip = getClientIp(req);
    const identity = resolveClientRateLimitIdentity(ip);
    // Unauthenticated: bound oauth_states row creation per source before it happens.
    const limit = getOAuthStartRateLimit("google", identity, env);
    if (!rateLimit(limit.key, limit.max, limit.windowMs)) {
      return rateLimitedRedirect();
    }

    const next = normalizeMagicLinkRedirectPath(req.nextUrl.searchParams.get("next"));
    const { authorizationUrl, browserBinding } = await beginOAuthLogin("google", {
      redirectPath: next,
      ip,
      userAgent: getUserAgent(req),
    });
    const response = NextResponse.redirect(authorizationUrl, { status: 302 });
    response.cookies.set(getOAuthBrowserBindingCookie("google"), browserBinding, {
      httpOnly: true,
      secure: getEnv().APP_URL.startsWith("https://"),
      sameSite: "lax",
      path: getOAuthCookiePath(),
      maxAge: OAUTH_STATE_TTL_MINUTES * 60,
    });
    return response;
  } catch (error) {
    const response = handleApiError(error);
    // Browser start failures: bounce to login with generic error.
    if (response.status >= 400) {
      const url = absoluteUrl("/login");
      url.searchParams.set("oauth_error", "start");
      return NextResponse.redirect(url, { status: 303 });
    }
    return response;
  }
}
