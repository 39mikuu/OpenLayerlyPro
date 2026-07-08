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
        const beforeLogout = new Event("admin:before-logout", { cancelable: true });
        if (!window.dispatchEvent(beforeLogout)) return;
        await api("/api/auth/logout", { method: "POST" });
        window.location.assign("/");
      }}
    >
      {t("common.logout")}
    </Button>
  );
}
