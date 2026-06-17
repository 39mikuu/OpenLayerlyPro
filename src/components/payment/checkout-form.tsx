"use client";

import { Check, FileImage, ImageUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, uploadFile } from "@/lib/client";
import { cn } from "@/lib/utils";

type Method = {
  id: string;
  name: string;
  description: string | null;
  qrFileId: string | null;
};

export function CheckoutForm({ tierId, methods }: { tierId: string; methods: Method[] }) {
  const t = useT();
  const router = useRouter();
  const proofInputId = useId();
  const [methodId, setMethodId] = useState<string | null>(methods[0]?.id ?? null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = methods.find((method) => method.id === methodId);

  async function submit() {
    if (!proofFile) {
      setError(t("checkout.uploadFirst"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const proof = await uploadFile<{ id: string }>("/api/files/upload-payment-proof", proofFile);
      await api("/api/payment-requests", {
        method: "POST",
        body: {
          tierId,
          paymentMethodId: methodId,
          proofFileId: proof.id,
          note: note || null,
        },
      });
      router.push("/me/orders");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkout.submitFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (methods.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card px-6 py-10 text-center">
        <p className="font-medium">{t("checkout.noMethodsTitle")}</p>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
          {t("checkout.noMethods")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div className="grid gap-3 sm:grid-cols-2">
        {methods.map((method) => {
          const isSelected = method.id === methodId;
          return (
            <button
              key={method.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setMethodId(method.id)}
              className={cn(
                "relative min-w-0 rounded-xl border bg-card p-4 text-left transition",
                "hover:border-primary/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                isSelected && "border-primary bg-blue-50/50 shadow-sm dark:bg-blue-950/20",
              )}
            >
              <span className="block pr-7 font-semibold">{method.name}</span>
              {method.description && (
                <span className="mt-1 block line-clamp-2 text-sm leading-5 text-muted-foreground">
                  {method.description}
                </span>
              )}
              <span
                className={cn(
                  "absolute right-3 top-3 flex size-5 items-center justify-center rounded-full border",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/30",
                )}
              >
                {isSelected && <Check className="size-3" />}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="rounded-xl border bg-card p-5 sm:p-6">
          <div className="text-center">
            <h3 className="font-semibold">{selected.name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("checkout.completePayment")}</p>
          </div>

          {selected.qrFileId ? (
            <div className="mx-auto mt-5 w-full max-w-64 rounded-xl border bg-white p-3 shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/files/${selected.qrFileId}/download`}
                alt={t("checkout.qrAlt", { name: selected.name })}
                className="aspect-square w-full object-contain"
              />
            </div>
          ) : (
            <div className="mx-auto mt-5 max-w-md rounded-lg bg-muted/50 px-4 py-5 text-center text-sm text-muted-foreground">
              {t("checkout.noQr")}
            </div>
          )}

          {selected.description && (
            <p className="mx-auto mt-5 max-w-xl whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
              {selected.description}
            </p>
          )}
        </div>
      )}

      <div className="space-y-5 rounded-xl border bg-card p-5 sm:p-6">
        <div>
          <h3 className="font-semibold">{t("checkout.proofSectionTitle")}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {t("checkout.proofSectionHint")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor={proofInputId}>{t("checkout.uploadProof")}</Label>
          <Label
            htmlFor={proofInputId}
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/20 px-4 py-5 text-center hover:border-primary/40 hover:bg-blue-50/30 dark:hover:bg-blue-950/10"
          >
            {proofFile ? (
              <>
                <FileImage className="size-6 text-primary" />
                <span className="max-w-full truncate text-sm font-medium">{proofFile.name}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t("checkout.changeProof")}
                </span>
              </>
            ) : (
              <>
                <ImageUp className="size-6 text-primary" />
                <span className="text-sm font-medium">{t("checkout.chooseProof")}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t("checkout.proofFormats")}
                </span>
              </>
            )}
          </Label>
          <Input
            id={proofInputId}
            type="file"
            accept=".jpg,.jpeg,.png,.webp"
            className="sr-only"
            onChange={(event) => setProofFile(event.target.files?.[0] ?? null)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="note">{t("checkout.note")}</Label>
          <Textarea
            id="note"
            maxLength={500}
            placeholder={t("checkout.notePlaceholder")}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <Button className="w-full sm:w-auto" disabled={loading || !proofFile} onClick={submit}>
          {loading ? t("checkout.submitting") : t("checkout.submit")}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">{t("checkout.submitNotice")}</p>
      </div>
    </div>
  );
}
