import { redirect } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { getPublicSiteInfo, isInitialized } from "@/modules/site";
import { getPublicRenderConfig } from "@/modules/site/public-security";
import { getSupporterWallSettings } from "@/modules/supporter-wall";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  if (!(await isInitialized())) {
    redirect("/admin/setup");
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
