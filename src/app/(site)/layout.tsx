import { redirect } from "next/navigation";

import { getCurrentUser } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { getCustomFooterHtml, getPublicSiteInfo, isInitialized } from "@/modules/site";
import { getActiveTheme } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  if (!(await isInitialized())) {
    redirect("/admin/setup");
  }
  const [site, customFooterHtml, user, theme, t] = await Promise.all([
    getPublicSiteInfo(),
    getCustomFooterHtml(),
    getCurrentUser(),
    getActiveTheme(),
    getT(),
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
        customFooterHtml,
      }}
      t={t}
    >
      {children}
    </Chrome>
  );
}
