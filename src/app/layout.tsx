import "./globals.css";

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import { I18nProvider } from "@/components/i18n-provider";
import {
  IntegrationScriptElements,
  VerificationMetaElements,
} from "@/components/public-security-elements";
import { buildPublicUrl, getPublicBaseUrl } from "@/modules/content/public-projection";
import { DEFAULT_SITE_DESCRIPTION } from "@/modules/content/seo";
import { resolveLocale } from "@/modules/i18n/server";
import { getPublicSiteInfo } from "@/modules/site";
import {
  canRenderIntegrationRevision,
  getPublicRenderConfig,
} from "@/modules/site/public-security";
import {
  buildColorPresetCss,
  darkClassFromMode,
  getActiveTheme,
  getThemeConfig,
  THEME_INIT_SCRIPT,
  THEME_MODE_COOKIE,
} from "@/modules/theme";

const defaultMetadata: Metadata = {
  title: "Artist Member Site",
  description: DEFAULT_SITE_DESCRIPTION,
};
const DEFAULT_SITE_TITLE = "Artist Member Site";

export async function generateMetadata(): Promise<Metadata> {
  try {
    const site = await getPublicSiteInfo();
    const baseUrl = getPublicBaseUrl();
    const iconUrl = site.siteIconFileId ? `/api/files/${site.siteIconFileId}/download` : undefined;
    const title = site.siteName || DEFAULT_SITE_TITLE;
    const description = site.artistBio.trim() || DEFAULT_SITE_DESCRIPTION;
    return {
      ...defaultMetadata,
      metadataBase: new URL(baseUrl),
      title,
      description,
      icons: iconUrl ? { icon: iconUrl, apple: iconUrl } : undefined,
      openGraph: {
        siteName: title,
        description,
        url: buildPublicUrl(baseUrl, "/"),
      },
      twitter: {
        card: "summary",
        title,
        description,
      },
    };
  } catch {
    return defaultMetadata;
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const htmlClass = darkClassFromMode(cookieStore.get(THEME_MODE_COOKIE)?.value);
  const locale = await resolveLocale();
  const nonce = requestHeaders.get("x-nonce");
  const requestRevision = requestHeaders.get("x-csp-config-revision");
  const renderPublicSecurity = requestHeaders.get("x-public-security-render") === "1";

  // 颜色预设为站点级配置；读取失败（如 DB 暂不可用）时回落无覆盖，绝不阻断页面渲染。
  let presetCss: string | null = null;
  let verificationMeta: Awaited<ReturnType<typeof getPublicRenderConfig>>["verificationMeta"] = [];
  let integrationPlans: Awaited<ReturnType<typeof getPublicRenderConfig>>["integrationPlans"] = [];
  try {
    const [theme, security] = await Promise.all([
      getActiveTheme(),
      renderPublicSecurity ? getPublicRenderConfig() : null,
    ]);
    const themeConfig = await getThemeConfig(theme);
    presetCss = buildColorPresetCss(theme, themeConfig);
    verificationMeta = security?.verificationMeta ?? [];
    if (security && canRenderIntegrationRevision(requestRevision, security.revision, nonce)) {
      integrationPlans = security.integrationPlans;
    } else if (nonce && security && security.integrationPlans.length > 0) {
      console.warn(
        `[security] public integration revision changed during request (${requestRevision ?? "missing"} -> ${security.revision}); scripts skipped`,
      );
    }
  } catch {
    presetCss = null;
    verificationMeta = [];
    integrationPlans = [];
  }

  return (
    <html lang={locale} className={htmlClass} suppressHydrationWarning>
      <head>
        <VerificationMetaElements items={verificationMeta} />
        {nonce ? (
          <IntegrationScriptElements nonce={nonce} plans={integrationPlans} placement="head" />
        ) : null}
      </head>
      <body className="antialiased">
        <script
          nonce={nonce ?? undefined}
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
        {presetCss ? (
          <style nonce={nonce ?? undefined} dangerouslySetInnerHTML={{ __html: presetCss }} />
        ) : null}
        {nonce ? (
          <IntegrationScriptElements nonce={nonce} plans={integrationPlans} placement="body" />
        ) : null}
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
