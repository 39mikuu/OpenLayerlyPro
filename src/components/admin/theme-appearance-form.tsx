"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Notice } from "@/components/admin/primitives";
import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

export type ThemePresetOption = { id: string; name: string };

export type ThemeOption = {
  id: string;
  name: string;
  presets: ThemePresetOption[];
  supportsCustomColor: boolean;
  /** 该主题当前保存的配置（服务端已按主题分键读取并回落默认）。 */
  initial: { colorPreset: string; customHue: number };
};

export function ThemeAppearanceForm({
  activeTheme,
  options,
}: {
  activeTheme: string;
  options: ThemeOption[];
}) {
  const router = useRouter();
  const t = useT();
  const [themeId, setThemeId] = useState(activeTheme);
  // 每个主题的配色编辑状态独立保留，来回切换不丢失。
  const [configs, setConfigs] = useState<
    Record<string, { colorPreset: string; customHue: number }>
  >(() => Object.fromEntries(options.map((option) => [option.id, option.initial])));
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selected = options.find((option) => option.id === themeId) ?? options[0];
  const config = configs[selected.id] ?? selected.initial;

  function patchConfig(patch: Partial<{ colorPreset: string; customHue: number }>) {
    setConfigs((prev) => ({ ...prev, [selected.id]: { ...config, ...patch } }));
  }

  async function save() {
    setLoading(true);
    setMessage(null);
    try {
      await api("/api/admin/theme", {
        method: "PUT",
        body: { theme: selected.id, colorPreset: config.colorPreset, customHue: config.customHue },
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
        <Label htmlFor="active-theme">{t("admin.site.theme")}</Label>
        <select
          id="active-theme"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={selected.id}
          onChange={(event) => setThemeId(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t("admin.site.themeHelp")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="color-preset">{t("admin.site.colorPreset")}</Label>
        <select
          id="color-preset"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={config.colorPreset}
          onChange={(event) => patchConfig({ colorPreset: event.target.value })}
        >
          {selected.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {selected.supportsCustomColor ? (
            <option value="custom">{t("admin.site.custom")}</option>
          ) : null}
        </select>
        <p className="text-xs text-muted-foreground">{t("admin.site.colorScope")}</p>
      </div>
      {config.colorPreset === "custom" && selected.supportsCustomColor ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="custom-hue">{t("admin.site.hue")}</Label>
            <div className="flex items-center gap-2 text-sm tabular-nums">
              <span
                aria-hidden="true"
                className="size-6 rounded-full border shadow-xs"
                style={{ background: `oklch(0.6 0.18 ${config.customHue})` }}
              />
              <span>{config.customHue}°</span>
            </div>
          </div>
          <input
            id="custom-hue"
            type="range"
            min="0"
            max="359"
            step="1"
            value={config.customHue}
            onChange={(event) => patchConfig({ customHue: Number(event.target.value) })}
            className="w-full accent-primary"
          />
          <p className="text-xs text-muted-foreground">{t("admin.site.hueHelp")}</p>
        </div>
      ) : null}
      {message && <Notice>{message}</Notice>}
      <Button disabled={loading} onClick={save}>
        {t("admin.common.save")}
      </Button>
    </div>
  );
}
