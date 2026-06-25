"use client";

import { XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function SubscriptionCancelButton({ subscriptionId }: { subscriptionId: string }) {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelSubscription() {
    setLoading(true);
    setError(null);
    try {
      await api("/api/me/subscription/cancel", {
        method: "POST",
        body: { subscriptionId },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("me.cancelSubscriptionFailed"));
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" disabled={loading} onClick={cancelSubscription}>
        <XCircle className="size-4" />
        {loading ? t("me.cancelingSubscription") : t("me.cancelSubscription")}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
