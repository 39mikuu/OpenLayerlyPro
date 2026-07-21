import { NextRequest, NextResponse } from "next/server";

import { getClientIp, getUserAgent, handleApiError } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { completeOAuthLogin, OAUTH_BROWSER_BINDING_COOKIE } from "@/modules/auth/oauth";
import { createSession, setSessionCookie } from "@/modules/auth/session";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";

export const runtime = "nodejs";

function absoluteUrl(path: string): URL {
  return new URL(buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), path));
}

function clearBindingCookie(response: NextResponse): NextResponse {
  response.cookies.set(OAUTH_BROWSER_BINDING_COOKIE, "", {
    httpOnly: true,
    secure: getEnv().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/api/auth/oauth",
    maxAge: 0,
  });
  return response;
}

function failureRedirect(code: string): NextResponse {
  const url = absoluteUrl("/login");
  url.searchParams.set("oauth_error", code);
  return clearBindingCookie(
    NextResponse.redirect(url, {
      status: 303,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    }),
  );
}

export async function GET(req: NextRequest) {
  try {
    if (req.nextUrl.searchParams.get("error")) {
      return failureRedirect("denied");
    }
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const browserBinding = req.cookies.get(OAUTH_BROWSER_BINDING_COOKIE)?.value ?? null;
    const result = await completeOAuthLogin("google", { code, state, browserBinding });
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
      return failureRedirect(map[error.code] ?? "failed");
    }
    handleApiError(error);
    return failureRedirect("failed");
  }
}
