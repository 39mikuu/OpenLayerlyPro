"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function NewPostEmailToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/me/notification-preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPostEmailEnabled: !enabled }),
      });
      if (!response.ok) throw new Error(t("me.newPostEmailFailed"));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("me.newPostEmailFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" disabled={loading} onClick={toggle}>
        {loading
          ? t("me.newPostEmailSaving")
          : enabled
            ? t("me.disableNewPostEmail")
            : t("me.enableNewPostEmail")}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
