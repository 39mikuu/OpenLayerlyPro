"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

export function DeleteButton({
  path,
  confirmText,
  label,
}: {
  path: string;
  confirmText: string;
  label?: string;
}) {
  const router = useRouter();
  const t = useT();
  const [loading, setLoading] = useState(false);
  return (
    <Button
      size="sm"
      variant="destructive"
      disabled={loading}
      onClick={async () => {
        if (!confirm(confirmText)) return;
        setLoading(true);
        try {
          await api(path, { method: "DELETE" });
          router.refresh();
        } catch (err) {
          alert(err instanceof Error ? err.message : t("admin.common.deleteFailed"));
        } finally {
          setLoading(false);
        }
      }}
    >
      {label ?? t("admin.common.delete")}
    </Button>
  );
}
