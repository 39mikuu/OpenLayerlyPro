"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ErrorSummary } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, uploadFile } from "@/lib/client";
import type { LegacyFooterStatus, SiteVerification } from "@/modules/site/public-security";

type SocialLink = { name: string; url: string; enabled?: boolean };

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
    <div className="max-w-2xl space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">{t("admin.site.basicInfo")}</h2>
          <p className="text-sm text-muted-foreground">{t("admin.site.basicInfoDescription")}</p>
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.siteName")}</Label>
          <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.artistName")}</Label>
          <Input value={artistName} onChange={(e) => setArtistName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.artistBio")}</Label>
          <Textarea rows={4} value={artistBio} onChange={(e) => setArtistBio(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.avatar")}</Label>
          {avatarFileId && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/files/${avatarFileId}/download`}
              alt={t("admin.site.avatarAlt")}
              className="w-20 h-20 rounded-full object-cover border"
            />
          )}
          <Input
            type="file"
            accept=".jpg,.jpeg,.png,.webp"
            onChange={(e) => onAvatarChange(e.target.files?.[0] ?? null)}
          />
        </div>
      </section>

      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <h2 className="text-base font-semibold">{t("admin.site.branding")}</h2>
          <p className="text-sm text-muted-foreground">{t("admin.site.brandingDescription")}</p>
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.logo")}</Label>
          {logoFileId && (
            <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${logoFileId}/download`}
                alt={t("admin.site.logoAlt")}
                className="max-h-16 max-w-48 object-contain"
              />
              <Button variant="outline" size="sm" onClick={() => setLogoFileId(null)}>
                {t("admin.site.clearLogo")}
              </Button>
            </div>
          )}
          <Input
            type="file"
            accept=".jpg,.jpeg,.png,.webp"
            onChange={(e) => uploadBrandAsset(e.target.files?.[0] ?? null, "logo")}
          />
          <p className="text-xs text-muted-foreground">{t("admin.site.logoHelp")}</p>
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.icon")}</Label>
          {iconFileId && (
            <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${iconFileId}/download`}
                alt={t("admin.site.iconAlt")}
                className="size-16 rounded-xl border object-cover"
              />
              <Button variant="outline" size="sm" onClick={() => setIconFileId(null)}>
                {t("admin.site.clearIcon")}
              </Button>
            </div>
          )}
          <Input
            type="file"
            accept=".jpg,.jpeg,.png,.webp"
            onChange={(e) => uploadBrandAsset(e.target.files?.[0] ?? null, "icon")}
          />
          <p className="text-xs text-muted-foreground">{t("admin.site.iconHelp")}</p>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <h2 className="text-base font-semibold">{t("admin.site.paymentProofRetention")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("admin.site.paymentProofRetentionDescription")}
          </p>
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.paymentProofApprovedRetentionDays")}</Label>
          <Input
            type="number"
            min={0}
            max={3650}
            step={1}
            value={paymentProofApprovedRetentionDays}
            onChange={(e) => setPaymentProofApprovedRetentionDays(Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            {t("admin.site.paymentProofApprovedRetentionHelp")}
          </p>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <h2 className="text-base font-semibold">{t("admin.site.publicSecurity")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("admin.site.publicSecurityDescription")}
          </p>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {t("admin.site.cspStatus", {
            configured: initial.cspMode,
            effective: initial.effectiveCspMode,
          })}
        </div>
        {initial.legacyFooterStatus === "needs_migration" ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
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
        <div className="space-y-2">
          <Label>{t("admin.site.customFooterMarkup")}</Label>
          <Textarea
            rows={8}
            value={customFooterMarkup}
            onChange={(e) => setCustomFooterMarkup(e.target.value)}
            placeholder="<p>...</p>"
          />
          <p className="text-xs text-muted-foreground">{t("admin.site.safeMarkupHelp")}</p>
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.siteVerification")}</Label>
          <Textarea
            rows={6}
            value={siteVerificationJson}
            onChange={(e) => setSiteVerificationJson(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("admin.site.siteVerificationHelp")}</p>
        </div>
        <div className="space-y-2">
          <Label>{t("admin.site.publicIntegrations")}</Label>
          <Textarea
            rows={10}
            value={publicIntegrationsJson}
            onChange={(e) => setPublicIntegrationsJson(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("admin.site.publicIntegrationsHelp")}</p>
        </div>
        {legacyFooterHtml ? (
          <div className="space-y-2 rounded-md border border-amber-300 p-3">
            <Label>{t("admin.site.legacyFooter")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("admin.site.legacyFooterStatus", { status: initial.legacyFooterStatus })}
            </p>
            <Textarea rows={8} value={legacyFooterHtml} readOnly />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={copyLegacyFooter}>
                {t("admin.site.copyLegacyFooter")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={downloadLegacyFooter}>
                {t("admin.site.downloadLegacyFooter")}
              </Button>
              {initial.legacyFooterStatus === "safe_markup" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
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
                disabled={loading}
                onClick={() => updateLegacyFooter("clear")}
              >
                {t("admin.site.clearLegacyFooter")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-4">
        <div className="space-y-2">
          <Label>{t("admin.site.socialLinks")}</Label>
          {links.map((link, i) => (
            <div key={i} className="flex gap-2">
              <Input
                placeholder={t("admin.site.platformName")}
                className="w-32"
                value={link.name}
                onChange={(e) =>
                  setLinks(links.map((l, j) => (j === i ? { ...l, name: e.target.value } : l)))
                }
              />
              <Input
                placeholder="https://..."
                value={link.url}
                onChange={(e) =>
                  setLinks(links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))
                }
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLinks(links.filter((_, j) => j !== i))}
              >
                {t("admin.common.delete")}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLinks([...links, { name: "", url: "" }])}
          >
            {t("admin.site.addLink")}
          </Button>
        </div>
      </section>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <Button disabled={loading} onClick={save}>
        {t("admin.site.saveSettings")}
      </Button>
    </div>
  );
}
