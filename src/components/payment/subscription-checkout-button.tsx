"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function SubscriptionCheckoutButton({ tierId }: { tierId: string }) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startSubscription() {
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ redirectUrl: string }>("/api/payments/subscribe", {
        method: "POST",
        body: { tierId },
      });
      window.location.assign(result.redirectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("tiers.subscribeFailed"));
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        className="w-full"
        variant="secondary"
        aria-busy={loading}
        disabled={loading}
        onClick={startSubscription}
      >
        <RefreshCw className="size-4" />
        {loading ? t("tiers.subscribing") : t("tiers.subscribe")}
      </Button>
      <p role="status" aria-live="polite" className="sr-only">
        {loading ? t("tiers.subscribing") : ""}
      </p>
      <p role="alert" className={error ? "text-sm text-destructive" : "sr-only"}>
        {error}
      </p>
    </div>
  );
}
