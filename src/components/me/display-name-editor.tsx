"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";

export function DisplayNameEditor({ displayName }: { displayName: string | null }) {
  const router = useRouter();
  const t = useT();
  const [value, setValue] = useState(displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(nextDisplayName: string | null) {
    setSaving(true);
    setError(null);
    try {
      await api("/api/me/profile", {
        method: "PATCH",
        body: { displayName: nextDisplayName },
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("me.displayNameFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save(value.trim() || null);
      }}
    >
      <label className="space-y-2 text-sm font-medium">
        <span>{t("me.displayNameLabel")}</span>
        <Input
          maxLength={50}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("me.displayNamePlaceholder")}
        />
      </label>
      <p className="text-xs leading-5 text-muted-foreground">{t("me.displayNameHint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? t("me.displayNameSaving") : t("me.displayNameSave")}
        </Button>
        {displayName ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setValue("");
              void save(null);
            }}
          >
            {t("me.displayNameClear")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
