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
      <Button className="w-full sm:w-auto" disabled={loading} onClick={startCheckout}>
        {loading ? t("checkout.redirecting") : t("checkout.payOnline")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("checkout.stripeHosted")}</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
