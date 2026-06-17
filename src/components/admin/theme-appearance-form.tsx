"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

export type ThemePresetOption = { id: string; name: string };

export function ThemeAppearanceForm({
  initial,
  presets,
  supportsCustomColor,
}: {
  initial: { colorPreset: string; customHue: number };
  presets: ThemePresetOption[];
  supportsCustomColor: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const [colorPreset, setColorPreset] = useState(initial.colorPreset);
  const [customHue, setCustomHue] = useState(initial.customHue);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setLoading(true);
    setMessage(null);
    try {
      await api("/api/admin/theme", {
        method: "PUT",
        body: { colorPreset, customHue },
      });
      setMessage(t("admin.site.savedLive"));
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.saveFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <div className="space-y-2">
        <Label htmlFor="color-preset">{t("admin.site.colorPreset")}</Label>
        <select
          id="color-preset"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={colorPreset}
          onChange={(event) => setColorPreset(event.target.value)}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {supportsCustomColor ? <option value="custom">{t("admin.site.custom")}</option> : null}
        </select>
        <p className="text-xs text-muted-foreground">{t("admin.site.colorScope")}</p>
      </div>
      {colorPreset === "custom" && supportsCustomColor ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="custom-hue">{t("admin.site.hue")}</Label>
            <div className="flex items-center gap-2 text-sm tabular-nums">
              <span
                aria-hidden="true"
                className="size-6 rounded-full border shadow-xs"
                style={{ background: `oklch(0.6 0.18 ${customHue})` }}
              />
              <span>{customHue}°</span>
            </div>
          </div>
          <input
            id="custom-hue"
            type="range"
            min="0"
            max="359"
            step="1"
            value={customHue}
            onChange={(event) => setCustomHue(Number(event.target.value))}
            className="w-full accent-primary"
          />
          <p className="text-xs text-muted-foreground">{t("admin.site.hueHelp")}</p>
        </div>
      ) : null}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <Button disabled={loading} onClick={save}>
        {t("admin.common.save")}
      </Button>
    </div>
  );
}
