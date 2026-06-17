"use client";

import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import type { IntegrationId } from "@/modules/integration";

export function IntegrationTestButton({
  integrationId,
  disabled,
  label,
  pendingLabel,
  successText,
}: {
  integrationId: IntegrationId;
  disabled?: boolean;
  label?: string;
  pendingLabel?: string;
  successText?: string;
}) {
  const [loading, setLoading] = useState(false);
  const t = useT();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        disabled={disabled || loading}
        onClick={async () => {
          setLoading(true);
          setMessage(null);
          try {
            await api(`/api/admin/integrations/${integrationId}/test`, { method: "POST" });
            setMessage(successText ?? t("admin.integrationTest.success"));
          } catch (err) {
            setMessage(err instanceof Error ? err.message : t("admin.integrationTest.failed"));
          } finally {
            setLoading(false);
          }
        }}
      >
        {loading
          ? (pendingLabel ?? t("admin.integrationTest.pending"))
          : (label ?? t("admin.integrationTest.label"))}
      </Button>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
