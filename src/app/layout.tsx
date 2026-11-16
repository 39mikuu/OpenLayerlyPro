import "./globals.css";

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import { I18nProvider } from "@/components/i18n-provider";
import {
  IntegrationScriptElements,
  VerificationMetaElements,
} from "@/components/public-security-elements";
import { getEnv } from "@/lib/env";
import { isPublishedPublicBlogArticle } from "@/modules/blog/public-article";
import { buildRootMetadataFromSite, ROOT_DEFAULT_METADATA } from "@/modules/content/root-metadata";
import { getBlogLocale, getClientMessages, resolveLocale } from "@/modules/i18n/server";
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

export async function generateMetadata(): Promise<Metadata> {
  try {
    const site = await getPublicSiteInfo();
    return buildRootMetadataFromSite(site);
  } catch {
    return ROOT_DEFAULT_METADATA;
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const publicBlog =
    getEnv().PERSONAL_BLOG_MODE && requestHeaders.get("x-personal-blog-document") === "1";
  const htmlClass = publicBlog
    ? ""
    : darkClassFromMode((await cookies()).get(THEME_MODE_COOKIE)?.value);
  const locale = publicBlog ? getBlogLocale() : await resolveLocale();
  const messages = getClientMessages(locale);
  const nonce = requestHeaders.get("x-nonce");
  const requestRevision = requestHeaders.get("x-csp-config-revision");
  let renderPublicSecurity = requestHeaders.get("x-public-security-render") === "1";
  const slug = requestHeaders.get("x-personal-blog-slug");
  if (renderPublicSecurity && slug) {
    try {
      renderPublicSecurity = await isPublishedPublicBlogArticle(slug);
    } catch {
      renderPublicSecurity = false;
    }
  }

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
        <I18nProvider locale={locale} messages={messages}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
