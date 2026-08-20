"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ErrorSummary, FormField, Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, uploadFile } from "@/lib/client";
import type { LegacyFooterStatus, SiteVerification } from "@/modules/site/public-security";

type SocialLink = { name: string; url: string; enabled?: boolean };

const SECTION_CLASS = "min-w-0 space-y-4 rounded-lg border p-4 sm:p-5";
const FILE_INPUT_CLASS = "h-auto min-h-8 max-w-full py-1 file:mr-2 file:max-w-full";

export function SiteSettingsForm({
  initial,
}: {
  initial: {
    siteName: string;
    artistName: string;
    artistBio: string;
    artistAvatarFileId: string | null;
    siteLogoFileId: string | null;
    siteIconFileId: string | null;
    customFooterMarkup: string;
    legacyFooterHtml: string;
    legacyFooterStatus: LegacyFooterStatus;
    siteVerification: SiteVerification;
    publicIntegrations: unknown;
    cspRevision: string;
    cspMode: "auto" | "report-only" | "enforce";
    effectiveCspMode: "report-only" | "enforce";
    publicSecurityConfigurationErrors: string[];
    paymentProofApprovedRetentionDays: number;
    socialLinks: SocialLink[];
  };
}) {
  const router = useRouter();
  const t = useT();
  const [siteName, setSiteName] = useState(initial.siteName);
  const [artistName, setArtistName] = useState(initial.artistName);
  const [artistBio, setArtistBio] = useState(initial.artistBio);
  const [avatarFileId, setAvatarFileId] = useState(initial.artistAvatarFileId);
  const [logoFileId, setLogoFileId] = useState(initial.siteLogoFileId);
  const [iconFileId, setIconFileId] = useState(initial.siteIconFileId);
  const [customFooterMarkup, setCustomFooterMarkup] = useState(initial.customFooterMarkup);
  const [legacyFooterHtml, setLegacyFooterHtml] = useState(initial.legacyFooterHtml);
  const [siteVerificationJson, setSiteVerificationJson] = useState(
    JSON.stringify(initial.siteVerification, null, 2),
  );
  const [publicIntegrationsJson, setPublicIntegrationsJson] = useState(
    JSON.stringify(initial.publicIntegrations, null, 2),
  );
  const [cspRevision, setCspRevision] = useState(initial.cspRevision);
  const [paymentProofApprovedRetentionDays, setPaymentProofApprovedRetentionDays] = useState(
    initial.paymentProofApprovedRetentionDays,
  );
  const [links, setLinks] = useState<SocialLink[]>(initial.socialLinks);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setLoading(true);
    setMessage(null);
    try {
      const updated = await api<{ cspRevision: string }>("/api/admin/site", {
        method: "PUT",
        body: {
          cspRevision,
          siteName,
          artistName,
          artistBio,
          artistAvatarFileId: avatarFileId,
          siteLogoFileId: logoFileId,
          siteIconFileId: iconFileId,
          customFooterMarkup,
          siteVerification: JSON.parse(siteVerificationJson) as unknown,
          publicIntegrations: JSON.parse(publicIntegrationsJson) as unknown,
          paymentProofApprovedRetentionDays,
          socialLinks: links.filter((l) => l.name && l.url),
        },
      });
      setCspRevision(updated.cspRevision);
      setMessage(t("admin.common.saved"));
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.saveFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function updateLegacyFooter(action: "migrate-safe" | "clear") {
    setLoading(true);
    setMessage(null);
    try {
      const updated = await api<{
        customFooterMarkup: string;
        legacyFooterHtml: string;
        cspRevision: string;
      }>("/api/admin/site", {
        method: "PUT",
        body: { cspRevision, legacyFooterAction: action },
      });
      setCustomFooterMarkup(updated.customFooterMarkup);
      setLegacyFooterHtml(updated.legacyFooterHtml);
      setCspRevision(updated.cspRevision);
      setMessage(t("admin.common.saved"));
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.saveFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function copyLegacyFooter() {
    await navigator.clipboard.writeText(legacyFooterHtml);
    setMessage(t("admin.site.legacyFooterCopied"));
  }

  function downloadLegacyFooter() {
    const url = URL.createObjectURL(
      new Blob([legacyFooterHtml], { type: "text/html;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "legacy-custom-footer.html";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function onAvatarChange(file: File | null) {
    if (!file) return;
    setLoading(true);
    setMessage(null);
    try {
      const record = await uploadFile<{ id: string }>("/api/admin/files/upload", file, {
        purpose: "artist_avatar",
      });
      setAvatarFileId(record.id);
      setMessage(t("admin.site.avatarUploaded"));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.uploadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function uploadBrandAsset(file: File | null, asset: "logo" | "icon") {
    if (!file) return;
    setLoading(true);
    setMessage(null);
    try {
      const record = await uploadFile<{ id: string }>("/api/admin/files/upload", file, {
        purpose: "artist_avatar",
      });
      if (asset === "logo") {
        setLogoFileId(record.id);
        setMessage(t("admin.site.logoUploaded"));
      } else {
        setIconFileId(record.id);
        setMessage(t("admin.site.iconUploaded"));
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.uploadFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-w-0 max-w-2xl space-y-6" data-testid="site-settings-form">
      <section className={SECTION_CLASS} aria-labelledby="site-basic-info-heading">
        <div>
          <h2 id="site-basic-info-heading" className="text-base font-semibold">
            {t("admin.site.basicInfo")}
          </h2>
          <p className="break-words text-sm text-muted-foreground">
            {t("admin.site.basicInfoDescription")}
          </p>
        </div>
        <FormField id="site-name" label={t("admin.site.siteName")}>
          <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} />
        </FormField>
        <FormField id="artist-name" label={t("admin.site.artistName")}>
          <Input value={artistName} onChange={(e) => setArtistName(e.target.value)} />
        </FormField>
        <FormField id="artist-bio" label={t("admin.site.artistBio")}>
          <Textarea rows={4} value={artistBio} onChange={(e) => setArtistBio(e.target.value)} />
        </FormField>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="artist-avatar">{t("admin.site.avatar")}</Label>
          {avatarFileId && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/files/${avatarFileId}/download`}
              alt={t("admin.site.avatarAlt")}
              className="w-20 h-20 rounded-full object-cover border"
            />
          )}
          <Input
            id="artist-avatar"
            type="file"
            className={FILE_INPUT_CLASS}
            accept=".jpg,.jpeg,.png,.webp"
            onChange={(e) => onAvatarChange(e.target.files?.[0] ?? null)}
          />
        </div>
      </section>

      <section className={SECTION_CLASS} aria-labelledby="site-branding-heading">
        <div>
          <h2 id="site-branding-heading" className="text-base font-semibold">
            {t("admin.site.branding")}
          </h2>
          <p className="break-words text-sm text-muted-foreground">
            {t("admin.site.brandingDescription")}
          </p>
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="site-logo">{t("admin.site.logo")}</Label>
          {logoFileId && (
            <div
              className="flex min-w-0 flex-col items-start gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center"
              data-testid="site-logo-preview"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${logoFileId}/download`}
                alt={t("admin.site.logoAlt")}
                className="max-h-16 max-w-full object-contain sm:max-w-48"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setLogoFileId(null)}
              >
                {t("admin.site.clearLogo")}
              </Button>
            </div>
          )}
          <Input
            id="site-logo"
            type="file"
            className={FILE_INPUT_CLASS}
            accept=".jpg,.jpeg,.png,.webp"
            aria-describedby="site-logo-description"
            onChange={(e) => uploadBrandAsset(e.target.files?.[0] ?? null, "logo")}
          />
          <p id="site-logo-description" className="text-xs text-muted-foreground">
            {t("admin.site.logoHelp")}
          </p>
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="site-icon">{t("admin.site.icon")}</Label>
          {iconFileId && (
            <div
              className="flex min-w-0 flex-col items-start gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center"
              data-testid="site-icon-preview"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${iconFileId}/download`}
                alt={t("admin.site.iconAlt")}
                className="size-16 rounded-xl border object-cover"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setIconFileId(null)}
              >
                {t("admin.site.clearIcon")}
              </Button>
            </div>
          )}
          <Input
            id="site-icon"
            type="file"
            className={FILE_INPUT_CLASS}
            accept=".jpg,.jpeg,.png,.webp"
            aria-describedby="site-icon-description"
            onChange={(e) => uploadBrandAsset(e.target.files?.[0] ?? null, "icon")}
          />
          <p id="site-icon-description" className="text-xs text-muted-foreground">
            {t("admin.site.iconHelp")}
          </p>
        </div>
      </section>

      <section className={SECTION_CLASS} aria-labelledby="site-payment-retention-heading">
        <div>
          <h2 id="site-payment-retention-heading" className="text-base font-semibold">
            {t("admin.site.paymentProofRetention")}
          </h2>
          <p className="break-words text-sm text-muted-foreground">
            {t("admin.site.paymentProofRetentionDescription")}
          </p>
        </div>
        <FormField
          id="payment-proof-retention-days"
          label={t("admin.site.paymentProofApprovedRetentionDays")}
          description={t("admin.site.paymentProofApprovedRetentionHelp")}
        >
          <Input
            type="number"
            min={0}
            max={3650}
            step={1}
            value={paymentProofApprovedRetentionDays}
            onChange={(e) => setPaymentProofApprovedRetentionDays(Number(e.target.value))}
          />
        </FormField>
      </section>

      <section className={SECTION_CLASS} aria-labelledby="site-public-security-heading">
        <div>
          <h2 id="site-public-security-heading" className="text-base font-semibold">
            {t("admin.site.publicSecurity")}
          </h2>
          <p className="break-words text-sm text-muted-foreground">
            {t("admin.site.publicSecurityDescription")}
          </p>
        </div>
        <div className="break-words rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 [overflow-wrap:anywhere]">
          {t("admin.site.cspStatus", {
            configured: initial.cspMode,
            effective: initial.effectiveCspMode,
          })}
        </div>
        {initial.legacyFooterStatus === "needs_migration" ? (
          <div className="break-words rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 [overflow-wrap:anywhere]">
            {t(
              initial.effectiveCspMode === "report-only"
                ? "admin.site.legacyFooterReportOnlyWarning"
                : "admin.site.legacyFooterEnforceWarning",
            )}
          </div>
        ) : null}
        <ErrorSummary
          errors={initial.publicSecurityConfigurationErrors}
          title={t("admin.site.publicSecurityConfigurationErrors")}
        />
        <FormField
          id="custom-footer-markup"
          label={t("admin.site.customFooterMarkup")}
          description={t("admin.site.safeMarkupHelp")}
        >
          <Textarea
            rows={8}
            className="font-mono text-xs [overflow-wrap:anywhere]"
            value={customFooterMarkup}
            onChange={(e) => setCustomFooterMarkup(e.target.value)}
            placeholder="<p>...</p>"
          />
        </FormField>
        <FormField
          id="site-verification-json"
          label={t("admin.site.siteVerification")}
          description={t("admin.site.siteVerificationHelp")}
        >
          <Textarea
            rows={6}
            className="font-mono text-xs [overflow-wrap:anywhere]"
            value={siteVerificationJson}
            onChange={(e) => setSiteVerificationJson(e.target.value)}
          />
        </FormField>
        <FormField
          id="public-integrations-json"
          label={t("admin.site.publicIntegrations")}
          description={t("admin.site.publicIntegrationsHelp")}
        >
          <Textarea
            rows={10}
            className="font-mono text-xs [overflow-wrap:anywhere]"
            value={publicIntegrationsJson}
            onChange={(e) => setPublicIntegrationsJson(e.target.value)}
          />
        </FormField>
        {legacyFooterHtml ? (
          <div className="space-y-2 rounded-md border border-amber-300 p-3">
            <Label htmlFor="legacy-footer-html">{t("admin.site.legacyFooter")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("admin.site.legacyFooterStatus", { status: initial.legacyFooterStatus })}
            </p>
            <Textarea
              id="legacy-footer-html"
              rows={8}
              className="font-mono text-xs [overflow-wrap:anywhere]"
              value={legacyFooterHtml}
              readOnly
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={copyLegacyFooter}
              >
                {t("admin.site.copyLegacyFooter")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={downloadLegacyFooter}
              >
                {t("admin.site.downloadLegacyFooter")}
              </Button>
              {initial.legacyFooterStatus === "safe_markup" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={loading}
                  onClick={() => updateLegacyFooter("migrate-safe")}
                >
                  {t("admin.site.migrateLegacyFooter")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="w-full sm:w-auto"
                disabled={loading}
                onClick={() => updateLegacyFooter("clear")}
              >
                {t("admin.site.clearLegacyFooter")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className={SECTION_CLASS} aria-labelledby="site-social-links-heading">
        <div>
          <h2 id="site-social-links-heading" className="text-base font-semibold">
            {t("admin.site.socialLinks")}
          </h2>
        </div>
        <div className="min-w-0 space-y-3">
          {links.map((link, i) => (
            <div
              key={i}
              className="grid min-w-0 gap-3 rounded-lg border p-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-end"
              data-testid="site-social-link-row"
            >
              <FormField id={`social-link-name-${i}`} label={t("admin.site.platformName")}>
                <Input
                  placeholder={t("admin.site.platformName")}
                  value={link.name}
                  onChange={(e) =>
                    setLinks(links.map((l, j) => (j === i ? { ...l, name: e.target.value } : l)))
                  }
                />
              </FormField>
              <FormField id={`social-link-url-${i}`} label={t("admin.site.linkUrl")}>
                <Input
                  type="url"
                  placeholder="https://..."
                  value={link.url}
                  onChange={(e) =>
                    setLinks(links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))
                  }
                />
              </FormField>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setLinks(links.filter((_, j) => j !== i))}
              >
                {t("admin.common.delete")}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => setLinks([...links, { name: "", url: "" }])}
          >
            {t("admin.site.addLink")}
          </Button>
        </div>
      </section>
      {message && <Notice className="break-words [overflow-wrap:anywhere]">{message}</Notice>}
      <Button type="button" className="w-full sm:w-auto" disabled={loading} onClick={save}>
        {t("admin.site.saveSettings")}
      </Button>
    </div>
  );
}
