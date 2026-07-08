"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfigSourceSummary } from "@/components/admin/config-source-summary";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

export type TranslationAdminView = {
  enabled: boolean;
  provider: "openai-compatible";
  model?: string;
  endpoint?: string;
  monthlyCharLimit?: number;
  directPublishEnabled: boolean;
  showMachineTranslationLabel: boolean;
  configured: boolean;
  hasDbOverride: boolean;
  apiKeySet: boolean;
};

export function TranslationConfigForm({ initial }: { initial: TranslationAdminView }) {
  const router = useRouter();
  const t = useT();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model ?? "");
  const [endpoint, setEndpoint] = useState(initial.endpoint ?? "");
  const [monthlyCharLimit, setMonthlyCharLimit] = useState(
    initial.monthlyCharLimit ? String(initial.monthlyCharLimit) : "",
  );
  const [directPublishEnabled, setDirectPublishEnabled] = useState(initial.directPublishEnabled);
  const [showMachineTranslationLabel, setShowMachineTranslationLabel] = useState(
    initial.showMachineTranslationLabel,
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    const limit = monthlyCharLimit.trim() ? Number(monthlyCharLimit) : null;
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
      setMessage(t("admin.translation.invalidLimit"));
      return;
    }

    setLoading(true);
    setMessage(null);
    try {
      await api("/api/admin/config/translation", {
        method: "PUT",
        body: {
          enabled,
          provider: "openai-compatible",
          apiKey,
          model,
          endpoint,
          monthlyCharLimit: limit,
          directPublishEnabled,
          showMachineTranslationLabel,
        },
      });
      setApiKey("");
      setMessage(t("admin.common.saved"));
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <Label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("admin.translation.enable")}
      </Label>
      <div className="space-y-2">
        <Label htmlFor="translation-endpoint">{t("admin.translation.endpoint")}</Label>
        <Input
          id="translation-endpoint"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://api.example.com/v1"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="translation-model">{t("admin.translation.model")}</Label>
        <Input
          id="translation-model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="translation-api-key">API Key</Label>
        <Input
          id="translation-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            initial.apiKeySet
              ? t("admin.translation.apiKeySet")
              : t("admin.translation.apiKeyMissing")
          }
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="translation-monthly-limit">{t("admin.translation.monthlyCharLimit")}</Label>
        <Input
          id="translation-monthly-limit"
          type="number"
          min={1}
          value={monthlyCharLimit}
          onChange={(event) => setMonthlyCharLimit(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("admin.translation.monthlyCharLimitHint")}
        </p>
      </div>
      <Label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={directPublishEnabled}
          onChange={(event) => setDirectPublishEnabled(event.target.checked)}
        />
        <span>
          {t("admin.translation.directPublish")}
          <span className="block text-xs text-muted-foreground">
            {t("admin.translation.directPublishWarning")}
          </span>
        </span>
      </Label>
      <Label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={showMachineTranslationLabel}
          onChange={(event) => setShowMachineTranslationLabel(event.target.checked)}
        />
        <span>{t("admin.translation.showMachineLabel")}</span>
      </Label>
      <p className="text-xs text-muted-foreground">{t("admin.translation.defaultReviewPolicy")}</p>
      <ConfigSourceSummary
        hasSensitiveFields
        source={initial.hasDbOverride ? "database" : "none"}
        supportsEnvironmentFallback={false}
      />
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <Button disabled={loading} onClick={save}>
        {t("admin.common.save")}
      </Button>
    </div>
  );
}
