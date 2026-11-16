import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/modules/auth/session";
import { getBlogCopy } from "@/modules/blog/copy";
import { getBlogLocale, getBlogT, getT, resolveLocale } from "@/modules/i18n/server";
import { getPublicSiteInfo, isInitialized } from "@/modules/site";
import { getPublicRenderConfig } from "@/modules/site/public-security";
import { getSupporterWallSettings } from "@/modules/supporter-wall";
import { getActiveTheme } from "@/modules/theme";
import { PersonalBlogChrome } from "@/themes/blog/personal";

export const dynamic = "force-dynamic";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  if (!(await isInitialized())) {
    redirect("/admin/setup");
  }
  if (getEnv().PERSONAL_BLOG_MODE) {
    const requestHeaders = await headers();
    const isPublicBlog = requestHeaders.get("x-personal-blog-document") === "1";
    const [site, security] = await Promise.all([
      getPublicSiteInfo(),
      requestHeaders.get("x-public-security-render") === "1" ? getPublicRenderConfig() : null,
    ]);
    const t = isPublicBlog ? getBlogT() : await getT();
    const copy = getBlogCopy(isPublicBlog ? getBlogLocale() : await resolveLocale());
    return (
      <PersonalBlogChrome
        inside={false}
        t={t}
        copy={copy}
        view={{
          siteName: site.siteName,
          artistName: site.artistName,
          avatarUrl: null,
          logoUrl: site.siteLogoFileId ? `/api/files/${site.siteLogoFileId}/download` : null,
          socialLinks: site.socialLinks.filter((link) => link.enabled !== false),
          isLoggedIn: false,
          supporterWallEnabled: false,
          customFooterMarkup: security?.footerHtml ?? "",
        }}
      >
        {children}
      </PersonalBlogChrome>
    );
  }
  const [site, publicSecurity, user, theme, t, supporterWallSettings] = await Promise.all([
    getPublicSiteInfo(),
    getPublicRenderConfig(),
    getCurrentUser(),
    getActiveTheme(),
    getT(),
    getSupporterWallSettings(),
  ]);

  const Chrome = theme.components.Chrome;
  return (
    <Chrome
      view={{
        siteName: site.siteName,
        artistName: site.artistName,
        avatarUrl: site.artistAvatarFileId
          ? `/api/files/${site.artistAvatarFileId}/download`
          : null,
        logoUrl: site.siteLogoFileId ? `/api/files/${site.siteLogoFileId}/download` : null,
        socialLinks: site.socialLinks
          .filter((link) => link.enabled !== false)
          .map((link) => ({ name: link.name, url: link.url })),
        isLoggedIn: !!user,
        supporterWallEnabled: supporterWallSettings.enabled,
        customFooterMarkup: publicSecurity.footerHtml,
      }}
      t={t}
    >
      {children}
    </Chrome>
  );
}
