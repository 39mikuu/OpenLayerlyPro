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
        await api("/api/auth/logout", { method: "POST" });
        window.location.assign("/");
      }}
    >
      {t("common.logout")}
    </Button>
  );
}
