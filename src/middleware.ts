import { NextRequest, NextResponse } from "next/server";

import { getEnv } from "@/lib/env";
import {
  buildContentSecurityPolicy,
  type CspSourceGroups,
  DOCUMENT_SECURITY_HEADERS,
  type EffectiveCspMode,
  HSTS_HEADER_VALUE,
} from "@/modules/security/csp";
import { isPublicIntegrationDocument } from "@/modules/site/public-integration-paths";
import {
  getConfiguredStorageCspSources,
  getPublicCspRuntimeConfig,
  readPublicSecurityState,
} from "@/modules/site/public-security";

export const config = {
  runtime: "nodejs",
  matcher: [
    "/((?!api(?:/|$)|download(?:/|$)|sitemaps(?:/|$)|_next/(?:static|image)(?:/|$)|(?:favicon\\.ico|robots\\.txt|sitemap\\.xml|feed\\.xml|file\\.svg|globe\\.svg|next\\.svg|vercel\\.svg|window\\.svg)$).*)",
  ],
};

function generateNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function isNotificationUnsubscribeDocument(pathname: string): boolean {
  return (
    pathname.startsWith("/unsubscribe/notifications/") ||
    pathname === "/unsubscribe/notifications/result"
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const env = getEnv();
  const publicIntegrationDocument = isPublicIntegrationDocument(request.nextUrl.pathname);
  const nonce = generateNonce();
  let effectiveMode: EffectiveCspMode = "enforce";
  let revision = "fail-closed";
  let sources: CspSourceGroups = {
    script: [],
    image: [],
    media: [],
    connect: [],
    frame: [],
  };

  try {
    if (publicIntegrationDocument) {
      const runtimeConfig = await getPublicCspRuntimeConfig();
      effectiveMode = runtimeConfig.effectiveMode;
      revision = runtimeConfig.revision;
      sources = runtimeConfig.sources;
    } else {
      const state = await readPublicSecurityState();
      effectiveMode = state.effectiveMode;
      revision = state.revision;
      try {
        const storageSources = await getConfiguredStorageCspSources();
        sources = { ...sources, image: storageSources, media: storageSources };
      } catch (error) {
        console.error(
          "[security] failed to derive storage CSP sources; using same-origin only",
          error,
        );
      }
    }
  } catch (error) {
    console.error(
      "[security] failed to load public CSP configuration; using fail-closed policy",
      error,
    );
  }

  const policy = buildContentSecurityPolicy({
    nonce,
    production: env.NODE_ENV === "production",
    upgradeInsecureRequests: env.NODE_ENV === "production" && isHttpsUrl(env.APP_URL),
    sources,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("x-public-security-render");
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-csp-config-revision", revision);
  requestHeaders.set("Content-Security-Policy", policy);
  if (publicIntegrationDocument) requestHeaders.set("x-public-security-render", "1");

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  const responseHeader =
    effectiveMode === "report-only"
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy";
  response.headers.set(responseHeader, policy);
  for (const [name, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  if (env.SECURITY_HSTS_ENABLED) {
    response.headers.set("Strict-Transport-Security", HSTS_HEADER_VALUE);
  }
  if (isNotificationUnsubscribeDocument(request.nextUrl.pathname)) {
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}
