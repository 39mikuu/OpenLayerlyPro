import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getEnv } from "@/lib/env";
import { isMagicLinkConfigured, normalizeMagicLinkRedirectPath } from "@/modules/auth/magic-link";
import { getOAuthApiBasePath } from "@/modules/auth/oauth";
import { getLoginCodePolicy } from "@/modules/auth/rate-limit-policy";
import { getCurrentUser } from "@/modules/auth/session";
import { getTurnstileConfig, isOAuthProviderLoginEnabled } from "@/modules/config";
import { getT } from "@/modules/i18n/server";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ admin?: string; next?: string; oauth_error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/me");
  const { admin, next, oauth_error: oauthError } = await searchParams;
  const loginCodePolicy = getLoginCodePolicy(getEnv());
  const redirectPath = normalizeMagicLinkRedirectPath(next) ?? undefined;
  const [turnstile, theme, t, googleOAuthEnabled, githubOAuthEnabled] = await Promise.all([
    getTurnstileConfig(),
    getActiveTheme(),
    getT(),
    isOAuthProviderLoginEnabled("google"),
    isOAuthProviderLoginEnabled("github"),
  ]);
  const Login = theme.components.Login;
  return (
    <Login
      t={t}
      view={{
        mode: admin === "1" ? "admin" : "fan",
        turnstileSiteKey: turnstile.enabled ? (turnstile.siteKey ?? undefined) : undefined,
        loginCodeLength: loginCodePolicy.length,
        loginCodePattern: loginCodePolicy.pattern.source,
        magicLinkEnabled: isMagicLinkConfigured(),
        magicLinkNext: redirectPath,
        googleOAuthEnabled,
        githubOAuthEnabled,
        oauthNext: redirectPath,
        oauthError: oauthError ?? null,
        oauthBasePath: getOAuthApiBasePath(),
      }}
    />
  );
}
