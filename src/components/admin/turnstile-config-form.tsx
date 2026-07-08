"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfigSourceSummary } from "@/components/admin/config-source-summary";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

type TurnstileEnvDefaults = {
  enabled: boolean;
  siteKey?: string;
  secretKeySet: boolean;
};

export type TurnstileAdminView = {
  enabled: boolean;
  siteKey?: string;
  secretKeySet: boolean;
  hasDbOverride: boolean;
  envDefaults: TurnstileEnvDefaults;
};

export function TurnstileConfigForm({ initial }: { initial: TurnstileAdminView }) {
  const router = useRouter();
  const t = useT();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [siteKey, setSiteKey] = useState(initial.siteKey ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(fn: () => Promise<void>, okMessage: string) {
    setLoading(true);
    setMessage(null);
    try {
      await fn();
      setSecretKey("");
      setMessage(okMessage);
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  function save() {
    return run(
      () =>
        api("/api/admin/config/turnstile", {
          method: "PUT",
          body: { enabled, siteKey, secretKey },
        }),
      t("admin.common.saved"),
    );
  }

  function importFromEnv() {
    setEnabled(initial.envDefaults.enabled);
    setSiteKey(initial.envDefaults.siteKey ?? "");
    setSecretKey("");
    setMessage(
      initial.envDefaults.secretKeySet
        ? t("admin.turnstile.imported")
        : t("admin.turnstile.importedPublic"),
    );
  }

  function restoreToEnv() {
    return run(
      () => api("/api/admin/config/turnstile", { method: "DELETE" }),
      t("admin.common.restoredEnv"),
    );
  }

  return (
    <div className="max-w-xl space-y-4">
      <Label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("admin.turnstile.enable")}
      </Label>

      <div className="space-y-2">
        <Label>Site Key</Label>
        <Input
          value={siteKey}
          onChange={(event) => setSiteKey(event.target.value)}
          placeholder={t("admin.turnstile.publicKey")}
        />
      </div>

      <div className="space-y-2">
        <Label>Secret Key</Label>
        <Input
          type="password"
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          placeholder={
            initial.secretKeySet ? t("admin.turnstile.secretSet") : t("admin.turnstile.secretHint")
          }
        />
      </div>

      <ConfigSourceSummary
        hasEnvironmentImportAction
        extraDetail={t("admin.turnstile.requirement")}
        hasSensitiveFields
        source={initial.hasDbOverride ? "database" : "environment"}
        supportsEnvironmentFallback
      />
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      <div className="flex flex-wrap gap-2">
        <Button disabled={loading} onClick={save}>
          {t("admin.common.save")}
        </Button>
        <Button variant="outline" disabled={loading} onClick={importFromEnv}>
          {t("admin.common.importEnv")}
        </Button>
        <Button
          variant="outline"
          disabled={loading || !initial.hasDbOverride}
          onClick={restoreToEnv}
        >
          {t("admin.common.restoreEnv")}
        </Button>
      </div>
    </div>
  );
}
