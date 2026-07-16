"use client";

import { useRouter } from "next/navigation";
import { useEffect, useReducer, useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import type { SupporterWallSettings } from "@/modules/supporter-wall";

import {
  createSupporterWallControlsState,
  type FanWallEntry,
  supporterWallControlsReducer,
} from "./supporter-wall-controls-model";

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
  const [controls, dispatch] = useReducer(
    supporterWallControlsReducer,
    initialEntry,
    createSupporterWallControlsState,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dedication, entry } = controls;

  // router.refresh() after a display-name change hands down a new
  // initialEntry (e.g. approved → pending) while client state persists;
  // without this sync the controls would keep showing the stale status.
  // Status/version always sync; the dedication text only syncs while the
  // fan has no unconfirmed input.
  useEffect(() => {
    dispatch({ type: "server-synced", entry: initialEntry });
  }, [initialEntry]);

  async function save() {
    setSaving(true);
    setError(null);
    const submitted = dedication;
    try {
      const next = await api<FanWallEntry>("/api/me/supporter-wall", {
        method: "PUT",
        body: { dedication: submitted || null },
      });
      dispatch({ type: "save-succeeded", entry: next, submittedDedication: submitted });
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
      dispatch({ type: "opted-out" });
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
          onChange={(event) => {
            dispatch({ type: "dedication-changed", dedication: event.target.value });
          }}
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
