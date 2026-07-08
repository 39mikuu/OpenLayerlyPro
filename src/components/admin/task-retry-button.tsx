"use client";

import { useRouter } from "next/navigation";

import { ConfirmActionButton } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { api } from "@/lib/client";

export function TaskRetryButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const t = useT();

  return (
    <ConfirmActionButton
      actionLabel={t("admin.tasks.retry")}
      cancelLabel={t("admin.common.cancel")}
      closeLabel={t("admin.common.close")}
      confirmLabel={t("admin.tasks.retryConfirmAction")}
      description={t("admin.tasks.retryDialogDescription")}
      errorFallback={t("admin.tasks.retryFailed")}
      loadingLabel={t("admin.tasks.retrying")}
      title={t("admin.tasks.retryDialogTitle")}
      variant="outline"
      onConfirm={async () => {
        await api(`/api/admin/tasks/${taskId}/retry`, { method: "POST" });
        router.refresh();
      }}
    />
  );
}
