import { NextRequest, NextResponse } from "next/server";

import { ApiError, getClientIp, getUserAgent, handleApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import {
  cancelOAuthLogin,
  completeOAuthLogin,
  getOAuthBrowserBindingCookie,
  getOAuthCookiePath,
} from "@/modules/auth/oauth";
import { createSession, setSessionCookie } from "@/modules/auth/session";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";

export const runtime = "nodejs";

function absoluteUrl(path: string): URL {
  return new URL(buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), path));
}

function clearBindingCookie(response: NextResponse): NextResponse {
  response.cookies.set(getOAuthBrowserBindingCookie("github"), "", {
    httpOnly: true,
    secure: getEnv().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: getOAuthCookiePath(),
    maxAge: 0,
  });
  return response;
}

function failureRedirect(code: string, clearCookie = true): NextResponse {
  const url = absoluteUrl("/login");
  url.searchParams.set("oauth_error", code);
  const response = NextResponse.redirect(url, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
  return clearCookie ? clearBindingCookie(response) : response;
}

export async function GET(req: NextRequest) {
  try {
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const browserBinding = req.cookies.get(getOAuthBrowserBindingCookie("github"))?.value ?? null;
    if (req.nextUrl.searchParams.get("error")) {
      await cancelOAuthLogin("github", { state, browserBinding });
      return failureRedirect("denied");
    }
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const result = await completeOAuthLogin("github", { code, state, browserBinding });
    const { token, expiresAt } = await createSession(result.user.id, {
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });
    await setSessionCookie(token, expiresAt);
    return clearBindingCookie(
      NextResponse.redirect(absoluteUrl(result.redirectPath ?? "/me"), {
        status: 303,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      }),
    );
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
      return failureRedirect(map[error.code] ?? "failed", error.code !== "oauthInvalidState");
    }
    handleApiError(error);
    return failureRedirect("failed");
  }
}
