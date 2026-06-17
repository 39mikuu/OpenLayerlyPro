"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function ReviewActions({ requestId }: { requestId: string }) {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setLoading(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={loading}
          onClick={() =>
            run(async () => {
              if (!confirm(t("admin.reviews.confirmApprove"))) return;
              await api(`/api/admin/payment-requests/${requestId}/approve`, { method: "POST" });
            })
          }
        >
          {t("admin.reviews.approve")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={loading}
          onClick={() =>
            run(async () => {
              const note = prompt(t("admin.reviews.rejectPrompt"));
              if (note === null) return;
              await api(`/api/admin/payment-requests/${requestId}/reject`, {
                method: "POST",
                body: { reviewNote: note || null },
              });
            })
          }
        >
          {t("admin.reviews.reject")}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
