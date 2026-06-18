"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function TaskRetryButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={loading}
        onClick={async () => {
          if (!confirm(t("admin.tasks.retryConfirm"))) return;
          setLoading(true);
          setError(null);
          try {
            await api(`/api/admin/tasks/${taskId}/retry`, { method: "POST" });
            router.refresh();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : t("admin.tasks.retryFailed"));
          } finally {
            setLoading(false);
          }
        }}
      >
        {loading ? t("admin.tasks.retrying") : t("admin.tasks.retry")}
      </Button>
      {error && <p className="max-w-48 whitespace-normal text-xs text-destructive">{error}</p>}
    </div>
  );
}
