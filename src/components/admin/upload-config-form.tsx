"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfigSourceSummary } from "@/components/admin/config-source-summary";
import { FormField, Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";

export type UploadAdminView = {
  maxUploadSizeMb: number;
  paymentProofMaxSizeMb: number;
  paymentProofConfiguredMb: number;
  paymentProofIsClamped: boolean;
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
    String(initial.paymentProofConfiguredMb),
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [paymentProofEffectiveMb, setPaymentProofEffectiveMb] = useState(
    initial.paymentProofMaxSizeMb,
  );
  const [paymentProofIsClamped, setPaymentProofIsClamped] = useState(initial.paymentProofIsClamped);

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
    return run(async () => {
      const fresh = await api<UploadAdminView>("/api/admin/config/upload", {
        method: "PUT",
        body: { maxUploadSizeMb: max, paymentProofMaxSizeMb: proof },
      });
      setMaxUploadSizeMb(String(fresh.maxUploadSizeMb));
      setPaymentProofMaxSizeMb(String(fresh.paymentProofConfiguredMb));
      setPaymentProofEffectiveMb(fresh.paymentProofMaxSizeMb);
      setPaymentProofIsClamped(fresh.paymentProofIsClamped);
    }, t("admin.upload.saved"));
  }

  function restoreToEnv() {
    return run(async () => {
      await api("/api/admin/config/upload", { method: "DELETE" });
      setMaxUploadSizeMb(String(initial.envDefaults.maxUploadSizeMb));
      setPaymentProofMaxSizeMb(String(initial.envDefaults.paymentProofMaxSizeMb));
      setPaymentProofEffectiveMb(initial.envDefaults.paymentProofMaxSizeMb);
      setPaymentProofIsClamped(false);
    }, t("admin.common.restoredEnv"));
  }

  return (
    <div className="max-w-xl space-y-4">
      <FormField
        id="max-upload-size"
        label={t("admin.upload.contentLimit")}
        description={t("admin.upload.contentHint", { size: initial.envDefaults.maxUploadSizeMb })}
      >
        <Input
          type="number"
          min={1}
          value={maxUploadSizeMb}
          onChange={(event) => setMaxUploadSizeMb(event.target.value)}
        />
      </FormField>

      <FormField
        id="payment-proof-size"
        label={t("admin.upload.proofLimit")}
        description={
          paymentProofIsClamped
            ? t("admin.upload.proofHintClamped", {
                size: initial.envDefaults.paymentProofMaxSizeMb,
                effective: paymentProofEffectiveMb,
              })
            : t("admin.upload.proofHint", {
                size: initial.envDefaults.paymentProofMaxSizeMb,
              })
        }
      >
        <Input
          type="number"
          min={1}
          value={paymentProofMaxSizeMb}
          onChange={(event) => setPaymentProofMaxSizeMb(event.target.value)}
        />
      </FormField>

      <ConfigSourceSummary
        extraDetail={t("admin.upload.applyHint")}
        source={initial.hasDbOverride ? "database" : "environment"}
        supportsEnvironmentFallback
      />
      {message && <Notice>{message}</Notice>}

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
