"use client";

import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function AutoCheckoutButton({ tierId }: { tierId: string }) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout() {
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ redirectUrl: string }>("/api/checkout/auto", {
        method: "POST",
        body: { tierId },
      });
      window.location.assign(result.redirectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkout.autoFailed"));
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        className="w-full sm:w-auto"
        aria-busy={loading}
        disabled={loading}
        onClick={startCheckout}
      >
        {loading ? t("checkout.redirecting") : t("checkout.payOnline")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("checkout.stripeHosted")}</p>
      <p role="status" aria-live="polite" className="sr-only">
        {loading ? t("checkout.redirecting") : ""}
      </p>
      <p role="alert" className={error ? "text-sm text-destructive" : "sr-only"}>
        {error}
      </p>
    </div>
  );
}
