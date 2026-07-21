import { OAuthProviderConfigForm } from "@/components/admin/oauth-config-form";
import { PageHeader } from "@/components/admin/primitives";
import { SmtpConfigForm } from "@/components/admin/smtp-config-form";
import { StorageConfigForm } from "@/components/admin/storage-config-form";
import { StripeConfigForm } from "@/components/admin/stripe-config-form";
import { TranslationConfigForm } from "@/components/admin/translation-config-form";
import { TurnstileConfigForm } from "@/components/admin/turnstile-config-form";
import { UploadConfigForm } from "@/components/admin/upload-config-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getOAuthProviderAdminView,
  getSmtpAdminView,
  getStorageAdminView,
  getStripeAdminView,
  getTranslationAdminView,
  getTurnstileAdminView,
  getUploadAdminView,
} from "@/modules/config";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const [smtp, turnstile, storage, stripe, upload, translation, oauthGoogle, oauthGithub] =
    await Promise.all([
      getSmtpAdminView(),
      getTurnstileAdminView(),
      getStorageAdminView(),
      getStripeAdminView(),
      getUploadAdminView(),
      getTranslationAdminView(),
      getOAuthProviderAdminView("google"),
      getOAuthProviderAdminView("github"),
    ]);
  const t = await getT();
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader description={t("admin.settings.description")} title={t("admin.settings.title")} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.settings.oauthGoogle")}</CardTitle>
          <CardDescription>{t("admin.settings.oauthGoogleDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <OAuthProviderConfigForm provider="google" initial={oauthGoogle} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.settings.oauthGithub")}</CardTitle>
          <CardDescription>{t("admin.settings.oauthGithubDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <OAuthProviderConfigForm provider="github" initial={oauthGithub} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.settings.stripe")}</CardTitle>
          <CardDescription>{t("admin.settings.stripeDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StripeConfigForm initial={stripe} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.settings.translation")}</CardTitle>
          <CardDescription>{t("admin.settings.translationDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TranslationConfigForm initial={translation} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.settings.smtp")}</CardTitle>
          <CardDescription>{t("admin.settings.smtpDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SmtpConfigForm initial={smtp} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.settings.turnstile")}</CardTitle>
          <CardDescription>{t("admin.settings.turnstileDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TurnstileConfigForm initial={turnstile} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.settings.storage")}</CardTitle>
          <CardDescription>{t("admin.settings.storageDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StorageConfigForm initial={storage} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.settings.upload")}</CardTitle>
          <CardDescription>{t("admin.settings.uploadDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <UploadConfigForm initial={upload} />
        </CardContent>
      </Card>
    </div>
  );
}
