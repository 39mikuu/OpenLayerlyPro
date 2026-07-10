"use client";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function LogoutButton() {
  const t = useT();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        const pending: Promise<void>[] = [];
        const beforeLogout = new CustomEvent("admin:before-logout", {
          cancelable: true,
          detail: { waitUntil: (promise: Promise<void>) => pending.push(promise) },
        });
        if (!window.dispatchEvent(beforeLogout)) return;
        await Promise.all(pending);
        try {
          await api("/api/auth/logout", { method: "POST" });
          window.location.assign("/");
        } catch (error) {
          window.dispatchEvent(new Event("admin:logout-aborted"));
          throw error;
        }
      }}
    >
      {t("common.logout")}
    </Button>
  );
}
