"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";
import type { SupporterWallSettings } from "@/modules/supporter-wall";
import { SUPPORTER_WALL_MAX_MIN_LEVEL } from "@/modules/supporter-wall/constants";

export function SupporterWallSettingsForm({ settings }: { settings: SupporterWallSettings }) {
  const router = useRouter();
  const t = useT();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [minLevel, setMinLevel] = useState(settings.minLevel?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const trimmed = minLevel.trim();
      const parsedMinLevel = trimmed === "" ? null : Number(trimmed);
      if (
        parsedMinLevel !== null &&
        (!Number.isInteger(parsedMinLevel) ||
          parsedMinLevel < 0 ||
          parsedMinLevel > SUPPORTER_WALL_MAX_MIN_LEVEL)
      ) {
        throw new Error(t("errors.supporterWallInvalidMinLevel"));
      }
      await api<SupporterWallSettings>("/api/admin/supporter-wall/settings", {
        method: "PUT",
        body: { enabled, minLevel: parsedMinLevel },
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("admin.common.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="grid gap-4 sm:max-w-xl" onSubmit={(event) => void save(event)}>
      <label className="flex items-center gap-3 text-sm font-medium">
        <input
          type="checkbox"
          className="size-4 rounded border-input"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("admin.supporterWall.enabled")}
      </label>
      <label className="space-y-2 text-sm font-medium">
        <span>{t("admin.supporterWall.minLevel")}</span>
        <Input
          inputMode="numeric"
          min={0}
          max={SUPPORTER_WALL_MAX_MIN_LEVEL}
          step={1}
          type="number"
          value={minLevel}
          onChange={(event) => setMinLevel(event.target.value)}
          placeholder={t("admin.supporterWall.minLevelPlaceholder")}
        />
      </label>
      <p className="text-xs text-muted-foreground">{t("admin.supporterWall.minLevelHint")}</p>
      <div>
        <Button size="sm" type="submit" disabled={saving}>
          {saving ? t("admin.common.saving") : t("admin.common.save")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
