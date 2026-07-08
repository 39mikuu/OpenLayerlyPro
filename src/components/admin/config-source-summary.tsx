"use client";

import type { ReactNode } from "react";

import { Notice, StatusBadge } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

export type AdminConfigSource = "database" | "environment" | "none";

const sourceTone: Record<AdminConfigSource, "info" | "neutral" | "warning"> = {
  database: "info",
  environment: "neutral",
  none: "warning",
};

export function ConfigSourceSummary({
  className,
  connectionTestUsesSavedConfig,
  extraDetail,
  hasEnvironmentImportAction,
  hasSensitiveFields,
  source,
  supportsEnvironmentFallback,
}: {
  className?: string;
  connectionTestUsesSavedConfig?: boolean;
  extraDetail?: ReactNode;
  hasEnvironmentImportAction?: boolean;
  hasSensitiveFields?: boolean;
  source: AdminConfigSource;
  supportsEnvironmentFallback: boolean;
}) {
  const t = useT();
  const details: ReactNode[] = [];

  if (source === "database") {
    details.push(
      t(
        supportsEnvironmentFallback
          ? "admin.configSource.databaseDetailWithEnv"
          : "admin.configSource.databaseDetailNoEnv",
      ),
    );
  }
  if (source === "environment") {
    details.push(t("admin.configSource.environmentDetail"));
  }
  if (source === "none") {
    details.push(
      t(
        supportsEnvironmentFallback
          ? "admin.configSource.noneDetailWithEnv"
          : "admin.configSource.noneDetailNoEnv",
      ),
    );
  }

  if (supportsEnvironmentFallback) {
    if (hasEnvironmentImportAction) details.push(t("admin.configSource.importEnvDraft"));
    details.push(t("admin.configSource.restoreEnvDeletesOverride"));
  } else {
    details.push(t("admin.configSource.noEnvironmentFallback"));
  }

  if (hasSensitiveFields) {
    details.push(
      t(
        supportsEnvironmentFallback
          ? "admin.configSource.secretPreservationWithEnv"
          : "admin.configSource.secretPreservationSavedOnly",
      ),
    );
  }
  if (connectionTestUsesSavedConfig) details.push(t("admin.configSource.testUsesSaved"));
  if (extraDetail) details.push(extraDetail);

  return (
    <Notice className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("admin.configSource.currentSource")}</span>
        <StatusBadge tone={sourceTone[source]}>
          {t(`admin.configSource.source.${source}`)}
        </StatusBadge>
      </div>
      <ul
        className="list-disc space-y-1 pl-5 text-xs text-muted-foreground"
        data-testid="admin-config-source-summary"
      >
        {details.map((detail, index) => (
          <li key={index}>{detail}</li>
        ))}
      </ul>
    </Notice>
  );
}
