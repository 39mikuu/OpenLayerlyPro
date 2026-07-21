import { NextRequest, NextResponse } from "next/server";

import { getClientIp, getUserAgent, handleApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { normalizeMagicLinkRedirectPath } from "@/modules/auth/magic-link";
import {
  beginOAuthLogin,
  OAUTH_BROWSER_BINDING_COOKIE,
  OAUTH_STATE_TTL_MINUTES,
} from "@/modules/auth/oauth";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";

export const runtime = "nodejs";

function absoluteUrl(path: string): URL {
  return new URL(buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), path));
}

export async function GET(req: NextRequest) {
  try {
    const next = normalizeMagicLinkRedirectPath(req.nextUrl.searchParams.get("next"));
    const { authorizationUrl, browserBinding } = await beginOAuthLogin("google", {
      redirectPath: next,
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });
    const response = NextResponse.redirect(authorizationUrl, { status: 302 });
    response.cookies.set(OAUTH_BROWSER_BINDING_COOKIE, browserBinding, {
      httpOnly: true,
      secure: getEnv().APP_URL.startsWith("https://"),
      sameSite: "lax",
      path: "/api/auth/oauth",
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
