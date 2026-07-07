import { SiteSettingsForm } from "@/components/admin/site-settings-form";
import { ThemeAppearanceForm } from "@/components/admin/theme-appearance-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getT } from "@/modules/i18n/server";
import { readAdminSiteInfo } from "@/modules/site";
import { getActiveTheme, getThemeConfig, themes } from "@/modules/theme";

export const dynamic = "force-dynamic";

export default async function AdminSitePage() {
  const site = await readAdminSiteInfo();
  const theme = await getActiveTheme();
  const themeOptions = await Promise.all(
    Object.values(themes).map(async (option) => {
      const config = await getThemeConfig(option);
      return {
        id: option.id,
        name: option.name,
        presets: option.colorPresets.map((p) => ({ id: p.id, name: p.name })),
        supportsCustomColor: typeof option.colorVarsFromHue === "function",
        initial: {
          colorPreset: config.colorPreset,
          customHue:
            config.customHue ?? option.colorPresets.find((preset) => preset.hue !== null)?.hue ?? 0,
        },
      };
    }),
  );
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
          customFooterMarkup: site.customFooterMarkup,
          legacyFooterHtml: site.legacyFooterHtml,
          legacyFooterStatus: site.legacyFooterStatus,
          siteVerification: site.siteVerification,
          publicIntegrations: site.publicIntegrations,
          cspRevision: site.cspRevision,
          cspMode: site.cspMode,
          effectiveCspMode: site.effectiveCspMode,
          publicSecurityConfigurationErrors: site.publicSecurityConfigurationErrors,
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
          <ThemeAppearanceForm activeTheme={theme.id} options={themeOptions} />
        </CardContent>
      </Card>
    </div>
  );
}
