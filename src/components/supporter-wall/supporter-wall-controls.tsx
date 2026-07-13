"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import type { SupporterWallSettings } from "@/modules/supporter-wall";

type FanWallEntry = {
  id: string;
  dedication: string | null;
  status: "pending" | "approved" | "hidden";
  version: number;
};

export function SupporterWallControls({
  displayName,
  initialEntry,
  settings,
}: {
  displayName: string | null;
  initialEntry: FanWallEntry | null;
  settings: SupporterWallSettings;
}) {
  const router = useRouter();
  const t = useT();
  const [entry, setEntry] = useState<FanWallEntry | null>(initialEntry);
  const [dedication, setDedication] = useState(initialEntry?.dedication ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // router.refresh() after a display-name change hands down a new
  // initialEntry (e.g. approved → pending) while client state persists;
  // without this sync the controls would keep showing the stale status.
  useEffect(() => {
    setEntry(initialEntry);
    setDedication(initialEntry?.dedication ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEntry?.id, initialEntry?.status, initialEntry?.version]);

  useEffect(() => {
    let cancelled = false;
    void api<{ entry: FanWallEntry | null }>("/api/me/supporter-wall")
      .then((data) => {
        if (cancelled) return;
        setEntry(data.entry);
        setDedication(data.entry?.dedication ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await api<FanWallEntry>("/api/me/supporter-wall", {
        method: "PUT",
        body: { dedication: dedication || null },
      });
      setEntry(next);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("me.supporterWallSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function optOut() {
    setSaving(true);
    setError(null);
    try {
      await api("/api/me/supporter-wall", { method: "DELETE" });
      setEntry(null);
      setDedication("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("me.supporterWallOptOutFailed"));
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = Boolean(displayName?.trim());

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
        <p className="font-medium">
          {entry ? t(`me.supporterWallStatus${entry.status}`) : t("me.supporterWallNotJoined")}
        </p>
        <p className="mt-1 text-muted-foreground">
          {settings.enabled ? t("me.supporterWallEnabledHint") : t("me.supporterWallDisabledHint")}
        </p>
        {!canSubmit ? (
          <p className="mt-2 text-destructive">{t("me.supporterWallDisplayNameRequired")}</p>
        ) : null}
      </div>

      <label className="space-y-2 text-sm font-medium">
        <span>{t("me.supporterWallDedicationLabel")}</span>
        <Textarea
          maxLength={200}
          rows={4}
          value={dedication}
          onChange={(event) => setDedication(event.target.value)}
          placeholder={t("me.supporterWallDedicationPlaceholder")}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {t("me.supporterWallDedicationCount", { count: dedication.length })}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={saving || !canSubmit} onClick={() => void save()}>
          {saving ? t("me.supporterWallSaving") : t("me.supporterWallSave")}
        </Button>
        {entry ? (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void optOut()}>
            {t("me.supporterWallOptOut")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
