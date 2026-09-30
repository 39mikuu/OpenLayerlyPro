"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, uploadFile } from "@/lib/client";

export function OrderActions({
  requestId,
  status,
  tierName,
}: {
  requestId: string;
  status: string;
  tierName: string;
}) {
  const t = useT();
  const router = useRouter();
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  async function run(fn: () => Promise<void>, progress: string, success: string) {
    setLoading(true);
    setError(null);
    setFeedback(progress);
    try {
      await fn();
      setFeedback(success);
      router.refresh();
    } catch (err) {
      setFeedback("");
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
          aria-busy={loading}
          disabled={loading}
          onClick={() =>
            run(
              async () => {
                await api(`/api/me/payment-requests/${requestId}/cancel`, { method: "POST" });
              },
              t("order.canceling"),
              t("order.cancelled"),
            )
          }
        >
          {loading ? t("order.canceling") : t("order.cancel")}
        </Button>
        <p
          role="status"
          aria-live="polite"
          className={feedback ? "text-xs text-muted-foreground" : "sr-only"}
        >
          {feedback}
        </p>
        <p role="alert" className={error ? "text-xs text-destructive" : "sr-only"}>
          {error}
        </p>
      </div>
    );
  }

  if (status === "rejected") {
    return (
      <div className="space-y-2">
        <Label htmlFor={inputId}>{t("order.proofLabel", { tier: tierName })}</Label>
        <p id={`${inputId}-formats`} className="text-xs text-muted-foreground">
          {t("checkout.proofFormats")}
        </p>
        <Input
          id={inputId}
          type="file"
          accept=".jpg,.jpeg,.png,.webp"
          className="h-8 text-xs"
          aria-describedby={`${inputId}-formats`}
          disabled={loading}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <p
          role="status"
          aria-live="polite"
          className={file ? "text-xs text-muted-foreground" : "sr-only"}
        >
          {file ? t("order.proofSelected", { name: file.name }) : ""}
        </p>
        <p
          role="status"
          aria-live="polite"
          className={feedback ? "text-xs text-muted-foreground" : "sr-only"}
        >
          {feedback}
        </p>
        <Button
          size="sm"
          aria-busy={loading}
          disabled={loading || !file}
          onClick={() =>
            run(
              async () => {
                if (!file) return;
                const proof = await uploadFile<{ id: string }>(
                  "/api/files/upload-payment-proof",
                  file,
                );
                await api(`/api/me/payment-requests/${requestId}/resubmit`, {
                  method: "POST",
                  body: { proofFileId: proof.id },
                });
              },
              t("order.resubmitting"),
              t("order.resubmitted"),
            )
          }
        >
          {loading ? t("order.resubmitting") : t("order.resubmit")}
        </Button>
        <p role="alert" className={error ? "text-xs text-destructive" : "sr-only"}>
          {error}
        </p>
      </div>
    );
  }

  return null;
}
