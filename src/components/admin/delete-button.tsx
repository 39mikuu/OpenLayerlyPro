"use client";

import { useRouter } from "next/navigation";

import { ConfirmActionButton } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { api } from "@/lib/client";

export function DeleteButton({
  confirmText,
  description,
  label,
  title,
  path,
}: {
  confirmText?: string;
  description?: string;
  label?: string;
  path: string;
  title?: string;
}) {
  const router = useRouter();
  const t = useT();
  return (
    <ConfirmActionButton
      actionLabel={label ?? t("admin.common.delete")}
      cancelLabel={t("admin.common.cancel")}
      closeLabel={t("admin.common.close")}
      confirmLabel={t("admin.common.delete")}
      description={description ?? confirmText ?? t("admin.common.deleteDialogDescription")}
      errorFallback={t("admin.common.deleteFailed")}
      loadingLabel={t("admin.common.deleting")}
      title={title ?? t("admin.common.deleteDialogTitle")}
      variant="destructive"
      onConfirm={async () => {
        await api(path, { method: "DELETE" });
        router.refresh();
      }}
    />
  );
}
