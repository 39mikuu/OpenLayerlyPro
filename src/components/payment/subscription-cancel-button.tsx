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
  const [status, setStatus] = useState("");

  async function cancelSubscription() {
    setLoading(true);
    setError(null);
    setStatus(t("me.cancelingSubscription"));
    try {
      await api("/api/me/subscription/cancel", {
        method: "POST",
        body: { subscriptionId },
      });
      setStatus(t("me.subscriptionCancelled"));
      router.refresh();
    } catch (err) {
      setStatus("");
      setError(err instanceof Error ? err.message : t("me.cancelSubscriptionFailed"));
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" aria-busy={loading} disabled={loading} onClick={cancelSubscription}>
        <XCircle className="size-4" />
        {loading ? t("me.cancelingSubscription") : t("me.cancelSubscription")}
      </Button>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      <p role="alert" className={error ? "text-sm text-destructive" : "sr-only"}>
        {error}
      </p>
    </div>
  );
}
