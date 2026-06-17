"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, uploadFile } from "@/lib/client";

export function OrderActions({ requestId, status }: { requestId: string; status: string }) {
  const t = useT();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setLoading(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.opFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (status === "pending_review") {
    return (
      <div className="space-y-1">
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() =>
            run(async () => {
              await api(`/api/me/payment-requests/${requestId}/cancel`, { method: "POST" });
            })
          }
        >
          {t("order.cancel")}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  if (status === "rejected") {
    return (
      <div className="space-y-2">
        <Input
          type="file"
          accept=".jpg,.jpeg,.png,.webp"
          className="h-8 text-xs"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <Button
          size="sm"
          disabled={loading || !file}
          onClick={() =>
            run(async () => {
              if (!file) return;
              const proof = await uploadFile<{ id: string }>(
                "/api/files/upload-payment-proof",
                file,
              );
              await api(`/api/me/payment-requests/${requestId}/resubmit`, {
                method: "POST",
                body: { proofFileId: proof.id },
              });
            })
          }
        >
          {t("order.resubmit")}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return null;
}
