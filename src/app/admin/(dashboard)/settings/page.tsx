import { SmtpConfigForm } from "@/components/admin/smtp-config-form";
import { StorageConfigForm } from "@/components/admin/storage-config-form";
import { TranslationConfigForm } from "@/components/admin/translation-config-form";
import { TurnstileConfigForm } from "@/components/admin/turnstile-config-form";
import { UploadConfigForm } from "@/components/admin/upload-config-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getSmtpAdminView,
  getStorageAdminView,
  getTranslationAdminView,
  getTurnstileAdminView,
  getUploadAdminView,
} from "@/modules/config";
import { getT } from "@/modules/i18n/server";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const [smtp, turnstile, storage, upload, translation] = await Promise.all([
    getSmtpAdminView(),
    getTurnstileAdminView(),
    getStorageAdminView(),
    getUploadAdminView(),
    getTranslationAdminView(),
  ]);
  const t = await getT();
  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-bold">{t("admin.settings.title")}</h1>
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
