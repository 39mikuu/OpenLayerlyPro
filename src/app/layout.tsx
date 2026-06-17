import "./globals.css";

import type { Metadata } from "next";
import { cookies } from "next/headers";

import { I18nProvider } from "@/components/i18n-provider";
import { resolveLocale } from "@/modules/i18n/server";
import { getPublicSiteInfo } from "@/modules/site";
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
  description: "开源画师会员站系统",
};

export async function generateMetadata(): Promise<Metadata> {
  try {
    const site = await getPublicSiteInfo();
    const iconUrl = site.siteIconFileId ? `/api/files/${site.siteIconFileId}/download` : undefined;
    return {
      ...defaultMetadata,
      title: site.siteName || defaultMetadata.title,
      icons: iconUrl ? { icon: iconUrl, apple: iconUrl } : undefined,
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
  const cookieStore = await cookies();
  const htmlClass = darkClassFromMode(cookieStore.get(THEME_MODE_COOKIE)?.value);
  const locale = await resolveLocale();

  // 颜色预设为站点级配置；读取失败（如 DB 暂不可用）时回落无覆盖，绝不阻断页面渲染。
  let presetCss: string | null = null;
  try {
    const theme = await getActiveTheme();
    const themeConfig = await getThemeConfig(theme);
    presetCss = buildColorPresetCss(theme, themeConfig);
  } catch {
    presetCss = null;
  }

  return (
    <html lang={locale} className={htmlClass} suppressHydrationWarning>
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {presetCss ? <style dangerouslySetInnerHTML={{ __html: presetCss }} /> : null}
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
