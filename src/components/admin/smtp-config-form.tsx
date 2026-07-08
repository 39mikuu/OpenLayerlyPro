"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfigSourceSummary } from "@/components/admin/config-source-summary";
import { IntegrationTestButton } from "@/components/admin/integration-test-button";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

type SmtpEnvDefaults = {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  from?: string;
  passwordSet: boolean;
};

export type SmtpAdminView = {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  from?: string;
  passwordSet: boolean;
  hasDbOverride: boolean;
  envDefaults: SmtpEnvDefaults;
};

export function SmtpConfigForm({ initial }: { initial: SmtpAdminView }) {
  const router = useRouter();
  const t = useT();
  const [host, setHost] = useState(initial.host ?? "");
  const [port, setPort] = useState(String(initial.port));
  const [secure, setSecure] = useState(initial.secure);
  const [user, setUser] = useState(initial.user ?? "");
  const [from, setFrom] = useState(initial.from ?? "");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 测试使用当前生效(已保存/环境变量)的配置,故以 initial 的生效值判断是否可测
  const canTest = Boolean(initial.host && initial.from);

  async function run(fn: () => Promise<void>, okMsg: string) {
    setLoading(true);
    setMessage(null);
    try {
      await fn();
      setMessage(okMsg);
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
        api("/api/admin/config/smtp", {
          method: "PUT",
          body: {
            host,
            port: Number(port),
            secure,
            user,
            from,
            password: password || undefined,
          },
        }),
      t("admin.common.saved"),
    );
  }

  function importFromEnv() {
    const e = initial.envDefaults;
    setHost(e.host ?? "");
    setPort(String(e.port));
    setSecure(e.secure);
    setUser(e.user ?? "");
    setFrom(e.from ?? "");
    setPassword("");
    setMessage(t("admin.smtp.imported"));
  }

  function restoreToEnv() {
    return run(
      () => api("/api/admin/config/smtp", { method: "DELETE" }),
      t("admin.common.restoredEnv"),
    );
  }

  return (
    <div className="max-w-xl space-y-4">
      <div className="space-y-2">
        <Label>{t("admin.smtp.host")}</Label>
        <Input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="smtp.example.com"
        />
      </div>
      <div className="flex gap-4">
        <div className="space-y-2 w-32">
          <Label>{t("admin.smtp.port")}</Label>
          <Input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="587"
          />
        </div>
        <div className="space-y-2 flex-1">
          <Label className="flex items-center gap-2">
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
            {t("admin.smtp.secure")}
          </Label>
        </div>
      </div>
      <div className="space-y-2">
        <Label>{t("admin.smtp.username")}</Label>
        <Input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder={t("admin.smtp.optional")}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin.smtp.password")}</Label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={initial.passwordSet ? t("admin.smtp.passwordSet") : t("admin.smtp.optional")}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("admin.smtp.from")}</Label>
        <Input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="Artist Site <no-reply@example.com>"
        />
      </div>

      <ConfigSourceSummary
        hasEnvironmentImportAction
        connectionTestUsesSavedConfig
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

      <div className="border-t pt-4 space-y-2">
        <Label>{t("admin.smtp.test")}</Label>
        <IntegrationTestButton
          integrationId="smtp"
          disabled={!canTest}
          label={t("admin.system.sendTest")}
          pendingLabel={t("admin.system.sending")}
          successText={t("admin.system.sent")}
        />
        {!canTest && <p className="text-xs text-muted-foreground">{t("admin.smtp.testHint")}</p>}
      </div>
    </div>
  );
}
