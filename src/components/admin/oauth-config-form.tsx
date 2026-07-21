"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfigSourceSummary } from "@/components/admin/config-source-summary";
import { FormField, LoadingButton, Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";
import type { OAuthProviderAdminView } from "@/modules/config/oauth";

export function OAuthProviderConfigForm({
  provider,
  initial,
}: {
  provider: "google" | "github";
  initial: OAuthProviderAdminView;
}) {
  const router = useRouter();
  const t = useT();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [clientId, setClientId] = useState(initial.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const endpoint = `/api/admin/config/oauth/${provider}`;

  async function run(action: () => Promise<void>, success: string) {
    setLoading(true);
    setMessage(null);
    try {
      await action();
      setClientSecret("");
      setMessage(success);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <Label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("admin.oauth.enable")}
      </Label>
      <FormField id={`${provider}-client-id`} label={t("admin.oauth.clientId")}>
        <Input
          id={`${provider}-client-id`}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
        />
      </FormField>
      <FormField id={`${provider}-client-secret`} label={t("admin.oauth.clientSecret")}>
        <Input
          id={`${provider}-client-secret`}
          type="password"
          autoComplete="new-password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={
            initial.clientSecretSet
              ? t("admin.oauth.secretSet")
              : t("admin.oauth.secretPlaceholder")
          }
        />
      </FormField>
      <Notice>{t("admin.oauth.securityHint")}</Notice>
      <ConfigSourceSummary
        hasSensitiveFields
        source={initial.hasDbOverride ? "database" : "none"}
        supportsEnvironmentFallback={false}
      />
      {message && <Notice>{message}</Notice>}
      <div className="flex flex-wrap gap-2">
        <LoadingButton
          loading={loading}
          onClick={() =>
            void run(
              () =>
                api(endpoint, {
                  method: "PUT",
                  body: { enabled, clientId, clientSecret },
                }),
              t("admin.common.saved"),
            )
          }
        >
          {t("admin.common.save")}
        </LoadingButton>
        <LoadingButton
          loading={loading}
          variant="outline"
          onClick={() =>
            void run(() => api(endpoint, { method: "DELETE" }), t("admin.common.cleared"))
          }
        >
          {t("admin.common.clear")}
        </LoadingButton>
      </div>
    </div>
  );
}
