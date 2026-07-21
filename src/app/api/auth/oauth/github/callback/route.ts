import { NextRequest, NextResponse } from "next/server";

import { ApiError, getClientIp, getUserAgent, handleApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { completeOAuthLogin } from "@/modules/auth/oauth";
import { createSession, setSessionCookie } from "@/modules/auth/session";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";

export const runtime = "nodejs";

function absoluteUrl(path: string): URL {
  return new URL(buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), path));
}

function failureRedirect(code: string): NextResponse {
  const url = absoluteUrl("/login");
  url.searchParams.set("oauth_error", code);
  return NextResponse.redirect(url, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    if (req.nextUrl.searchParams.get("error")) {
      return failureRedirect("denied");
    }
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const result = await completeOAuthLogin("github", { code, state });
    const { token, expiresAt } = await createSession(result.user.id, {
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });
    await setSessionCookie(token, expiresAt);
    return NextResponse.redirect(absoluteUrl(result.redirectPath ?? "/me"), {
      status: 303,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const map: Record<string, string> = {
        oauthInvalidState: "state",
        oauthEmailUnverified: "email",
        oauthBindFailed: "bind",
        oauthNotConfigured: "config",
        oauthProviderError: "provider",
        oauthInvalidCallback: "callback",
      };
      return failureRedirect(map[error.code] ?? "failed");
    }
    handleApiError(error);
    return failureRedirect("failed");
  }
}
