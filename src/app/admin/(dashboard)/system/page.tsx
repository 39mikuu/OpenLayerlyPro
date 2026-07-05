import { IntegrationTestButton } from "@/components/admin/integration-test-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Translate } from "@/modules/i18n";
import { getT } from "@/modules/i18n/server";
import type { IntegrationId, IntegrationSource, IntegrationStatus } from "@/modules/integration";
import { getSystemStatus } from "@/modules/system/status";

export const dynamic = "force-dynamic";

const INTEGRATION_KEYS: Record<IntegrationId, string> = {
  smtp: "admin.system.smtp",
  storage: "admin.system.storage",
  stripe: "admin.system.stripe",
  turnstile: "Cloudflare Turnstile",
  translation: "admin.system.translation",
  tunnel: "Cloudflare Tunnel",
};

const SOURCE_KEYS: Record<IntegrationSource, string> = {
  database: "admin.system.sourceDatabase",
  environment: "admin.system.sourceEnvironment",
  none: "admin.system.sourceNone",
};

function statusLabel(status: IntegrationStatus, t: Translate): string {
  if (status.error) return t("admin.system.readFailed");
  if (status.enabled && status.configured) return t("admin.system.enabled");
  if (!status.enabled && status.configured) return t("admin.system.disabledReady");
  return t("admin.system.incomplete");
}

function statusDetail(status: IntegrationStatus, t: Translate): string | null {
  if (status.error) return null;
  if (status.id === "storage" && status.driver === "local") {
    return t("admin.system.localDetail", {
      state: t(status.configured ? "admin.system.writable" : "admin.system.notWritable"),
    });
  }
  if (status.id === "storage" && status.driver === "s3") {
    return t("admin.system.s3Detail", {
      state: t(status.configured ? "admin.system.complete" : "admin.system.notComplete"),
    });
  }
  if (status.id === "tunnel") return t("admin.system.tunnelDetail");
  return null;
}

export default async function AdminSystemPage() {
  const status = await getSystemStatus();
  const smtp = status.integrations.find((integration) => integration.id === "smtp");
  const t = await getT();
  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-xl font-bold">{t("admin.system.title")}</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.system.runtime")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>App URL：{status.appUrl}</p>
          <p>
            {t("admin.overview.version")}：{status.version}
          </p>
          <p>
            {t("admin.overview.sourceCommit")}：{status.sourceCommit}
          </p>
          <p>
            {t("admin.overview.buildTimestamp")}：{status.buildTimestamp}
          </p>
          <p>
            {t("admin.system.database")}：
            {t(status.databaseOk ? "admin.overview.normal" : "admin.overview.abnormal")}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.system.integrations")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.integrations.map((integration) => {
            const detail = statusDetail(integration, t);
            return (
              <div key={integration.id} className="space-y-1 border-b pb-4 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">
                    {INTEGRATION_KEYS[integration.id].startsWith("admin.")
                      ? t(INTEGRATION_KEYS[integration.id])
                      : INTEGRATION_KEYS[integration.id]}
                  </span>
                  <span>{statusLabel(integration, t)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("admin.common.source")}：{t(SOURCE_KEYS[integration.source])}
                </p>
                {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
              </div>
            );
          })}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.system.mailTest")}</CardTitle>
        </CardHeader>
        <CardContent>
          <IntegrationTestButton
            integrationId="smtp"
            disabled={!smtp?.configured}
            label={t("admin.system.sendTest")}
            pendingLabel={t("admin.system.sending")}
            successText={t("admin.system.sent")}
          />
          {!smtp?.configured && (
            <p className="text-sm text-muted-foreground mt-2">{t("admin.system.configureSmtp")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
