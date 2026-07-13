"use client";

import { useRouter } from "next/navigation";

import { ConfirmActionButton } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { api } from "@/lib/client";

export function SupporterWallModerationActions({
  entryId,
  status,
  version,
}: {
  entryId: string;
  status: "pending" | "approved" | "hidden";
  version: number;
}) {
  const router = useRouter();
  const t = useT();

  async function moderate(action: "approve" | "hide") {
    await api(`/api/admin/supporter-wall/${entryId}/${action}`, {
      method: "POST",
      body: { expectedVersion: version },
    });
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      <ConfirmActionButton
        actionLabel={t("admin.supporterWall.approve")}
        cancelLabel={t("admin.common.cancel")}
        closeLabel={t("admin.common.close")}
        confirmLabel={t("admin.supporterWall.confirmApprove")}
        confirmVariant="default"
        description={t("admin.supporterWall.approveDescription")}
        disabled={status === "approved"}
        errorFallback={t("admin.supporterWall.moderationFailed")}
        loadingLabel={t("admin.supporterWall.approving")}
        title={t("admin.supporterWall.approveTitle")}
        variant="outline"
        onConfirm={() => moderate("approve")}
      />
      <ConfirmActionButton
        actionLabel={t("admin.supporterWall.hide")}
        cancelLabel={t("admin.common.cancel")}
        closeLabel={t("admin.common.close")}
        confirmLabel={t("admin.supporterWall.confirmHide")}
        description={t("admin.supporterWall.hideDescription")}
        disabled={status === "hidden"}
        errorFallback={t("admin.supporterWall.moderationFailed")}
        loadingLabel={t("admin.supporterWall.hiding")}
        title={t("admin.supporterWall.hideTitle")}
        variant="outline"
        onConfirm={() => moderate("hide")}
      />
    </div>
  );
}
