"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

export type UploadAdminView = {
  maxUploadSizeMb: number;
  paymentProofMaxSizeMb: number;
  hasDbOverride: boolean;
  envDefaults: {
    maxUploadSizeMb: number;
    paymentProofMaxSizeMb: number;
  };
};

export function UploadConfigForm({ initial }: { initial: UploadAdminView }) {
  const router = useRouter();
  const t = useT();
  const [maxUploadSizeMb, setMaxUploadSizeMb] = useState(String(initial.maxUploadSizeMb));
  const [paymentProofMaxSizeMb, setPaymentProofMaxSizeMb] = useState(
    String(initial.paymentProofMaxSizeMb),
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(fn: () => Promise<void>, okMessage: string) {
    setLoading(true);
    setMessage(null);
    try {
      await fn();
      setMessage(okMessage);
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  function toPositiveInt(value: string): number | undefined {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }

  function save() {
    const max = toPositiveInt(maxUploadSizeMb);
    const proof = toPositiveInt(paymentProofMaxSizeMb);
    if (max === undefined || proof === undefined) {
      setMessage(t("admin.upload.invalid"));
      return;
    }
    return run(
      () =>
        api("/api/admin/config/upload", {
          method: "PUT",
          body: { maxUploadSizeMb: max, paymentProofMaxSizeMb: proof },
        }),
      t("admin.upload.saved"),
    );
  }

  function restoreToEnv() {
    return run(async () => {
      await api("/api/admin/config/upload", { method: "DELETE" });
      setMaxUploadSizeMb(String(initial.envDefaults.maxUploadSizeMb));
      setPaymentProofMaxSizeMb(String(initial.envDefaults.paymentProofMaxSizeMb));
    }, t("admin.common.restoredEnv"));
  }

  return (
    <div className="max-w-xl space-y-4">
      <div className="space-y-2">
        <Label htmlFor="max-upload-size">{t("admin.upload.contentLimit")}</Label>
        <Input
          id="max-upload-size"
          type="number"
          min={1}
          value={maxUploadSizeMb}
          onChange={(event) => setMaxUploadSizeMb(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("admin.upload.contentHint", { size: initial.envDefaults.maxUploadSizeMb })}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="payment-proof-size">{t("admin.upload.proofLimit")}</Label>
        <Input
          id="payment-proof-size"
          type="number"
          min={1}
          value={paymentProofMaxSizeMb}
          onChange={(event) => setPaymentProofMaxSizeMb(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("admin.upload.proofHint", { size: initial.envDefaults.paymentProofMaxSizeMb })}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(initial.hasDbOverride ? "admin.common.dbOverride" : "admin.common.envSource")}
        {t("admin.upload.applyHint")}
      </p>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      <div className="flex flex-wrap gap-2">
        <Button disabled={loading} onClick={save}>
          {t("admin.common.save")}
        </Button>
        <Button
          variant="outline"
          disabled={loading || !initial.hasDbOverride}
          onClick={restoreToEnv}
        >
          {t("admin.common.restoreEnv")}
        </Button>
      </div>
    </div>
  );
}
