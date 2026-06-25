import { SiteSettingsForm } from "@/components/admin/site-settings-form";
import { ThemeAppearanceForm } from "@/components/admin/theme-appearance-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getT } from "@/modules/i18n/server";
import { readAdminSiteInfo } from "@/modules/site";
import { getActiveTheme, getThemeConfig } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function AdminSitePage() {
  const site = await readAdminSiteInfo();
  const theme = await getActiveTheme();
  const themeConfig = await getThemeConfig(theme);
  const t = await getT();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">{t("admin.site.title")}</h1>
      <SiteSettingsForm
        initial={{
          siteName: site.siteName,
          artistName: site.artistName,
          artistBio: site.artistBio,
          artistAvatarFileId: site.artistAvatarFileId,
          siteLogoFileId: site.siteLogoFileId,
          siteIconFileId: site.siteIconFileId,
          customFooterHtml: site.customFooterHtml,
          paymentProofApprovedRetentionDays: site.paymentProofApprovedRetentionDays,
          socialLinks: site.socialLinks,
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.site.appearance")}</CardTitle>
          <CardDescription>{t("admin.site.appearanceDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ThemeAppearanceForm
            initial={{
              colorPreset: themeConfig.colorPreset,
              customHue:
                themeConfig.customHue ??
                theme.colorPresets.find((preset) => preset.hue !== null)?.hue ??
                0,
            }}
            presets={theme.colorPresets.map((p) => ({ id: p.id, name: p.name }))}
            supportsCustomColor={typeof theme.colorVarsFromHue === "function"}
          />
        </CardContent>
      </Card>
    </div>
  );
}
