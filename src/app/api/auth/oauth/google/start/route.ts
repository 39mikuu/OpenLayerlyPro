import { NextRequest, NextResponse } from "next/server";

import { getClientIp, getUserAgent, handleApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { normalizeMagicLinkRedirectPath } from "@/modules/auth/magic-link";
import { beginOAuthLogin } from "@/modules/auth/oauth";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";

export const runtime = "nodejs";

function absoluteUrl(path: string): URL {
  return new URL(buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), path));
}

export async function GET(req: NextRequest) {
  try {
    const next = normalizeMagicLinkRedirectPath(req.nextUrl.searchParams.get("next"));
    const { authorizationUrl } = await beginOAuthLogin("google", {
      redirectPath: next,
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });
    return NextResponse.redirect(authorizationUrl, { status: 302 });
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
