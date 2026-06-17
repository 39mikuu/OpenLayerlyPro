"use client";

import { useRouter } from "next/navigation";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function LogoutButton() {
  const router = useRouter();
  const t = useT();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await api("/api/auth/logout", { method: "POST" });
        router.push("/");
        router.refresh();
      }}
    >
      {t("common.logout")}
    </Button>
  );
}
