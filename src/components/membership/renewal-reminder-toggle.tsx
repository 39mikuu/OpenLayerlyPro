"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function RenewalReminderToggle({ tierId, enabled }: { tierId: string; enabled: boolean }) {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/me/renewal-reminder", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tierId, enabled: !enabled }),
      });
      if (!response.ok) throw new Error(t("me.renewalReminderFailed"));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("me.renewalReminderFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" disabled={loading} onClick={toggle}>
        {loading
          ? t("me.renewalReminderSaving")
          : enabled
            ? t("me.disableRenewalReminder")
            : t("me.enableRenewalReminder")}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
