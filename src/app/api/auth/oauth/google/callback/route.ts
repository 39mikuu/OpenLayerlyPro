import { NextRequest, NextResponse } from "next/server";

import { getClientIp, getUserAgent, handleApiError } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { resolveClientRateLimitIdentity } from "@/lib/client-rate-limit";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import {
  cancelOAuthLogin,
  completeOAuthLogin,
  getOAuthBrowserBindingCookie,
  getOAuthCookiePath,
  getOAuthReturnCookie,
} from "@/modules/auth/oauth";
import { getOAuthStartRateLimit } from "@/modules/auth/rate-limit-policy";
import { normalizeMagicLinkRedirectPath } from "@/modules/auth/redirect-path";
import { createSession, setSessionCookie } from "@/modules/auth/session";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import { resolveLocale } from "@/modules/i18n/server";

export const runtime = "nodejs";

function absoluteUrl(path: string): URL {
  return new URL(buildPublicUrl(getPublicBaseUrl(getEnv().APP_URL), path));
}

function clearBindingCookie(response: NextResponse): NextResponse {
  response.cookies.set(getOAuthBrowserBindingCookie("google"), "", {
    httpOnly: true,
    secure: getEnv().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: getOAuthCookiePath(),
    maxAge: 0,
  });
  response.cookies.set(getOAuthReturnCookie("google"), "", {
    httpOnly: true,
    secure: getEnv().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: getOAuthCookiePath(),
    maxAge: 0,
  });
  return response;
}

function failureRedirect(code: string, next: string | null, clearCookie = true): NextResponse {
  const url = absoluteUrl("/login");
  url.searchParams.set("oauth_error", code);
  if (next) url.searchParams.set("next", next);
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
  const retryPath = normalizeMagicLinkRedirectPath(
    req.cookies.get(getOAuthReturnCookie("google"))?.value,
  );
  try {
    // Bound unauthenticated callback attempts before invalid states can amplify
    // into unbounded audit-event writes. Use a distinct namespace from starts.
    const env = getEnv();
    const identity = resolveClientRateLimitIdentity(getClientIp(req));
    const limit = getOAuthStartRateLimit("google-callback", identity, env);
    if (!rateLimit(limit.key, limit.max, limit.windowMs)) {
      // No state has been validated or consumed yet. Preserve the binding
      // cookie so a pending legitimate provider callback can still complete.
      return failureRedirect("rate_limited", retryPath, false);
    }
    const state = req.nextUrl.searchParams.get("state") ?? "";
    const browserBinding = req.cookies.get(getOAuthBrowserBindingCookie("google"))?.value ?? null;
    if (req.nextUrl.searchParams.get("error")) {
      await cancelOAuthLogin("google", { state, browserBinding });
      return failureRedirect("denied", retryPath);
    }
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const locale = await resolveLocale();
    const result = await completeOAuthLogin("google", { code, state, browserBinding, locale });
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
      return failureRedirect(
        map[error.code] ?? "failed",
        retryPath,
        error.code !== "oauthInvalidState",
      );
    }
    handleApiError(error);
    return failureRedirect("failed", retryPath);
  }
}
