import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import type { Theme, ThemeId } from "@/modules/theme";
import { applyThemeUpdate, getActiveTheme, getThemeConfig, themes } from "@/modules/theme";

export const runtime = "nodejs";

function isThemeId(value: string): value is ThemeId {
  return Object.hasOwn(themes, value);
}

async function themeOption(theme: Theme) {
  const config = await getThemeConfig(theme);
  return {
    id: theme.id,
    name: theme.name,
    // 只返回预设 id/name 与 hue 数字，不暴露完整 CSS 变量 map。
    presets: theme.colorPresets.map((p) => ({ id: p.id, name: p.name })),
    supportsCustomColor: typeof theme.colorVarsFromHue === "function",
    colorPreset: config.colorPreset,
    customHue: config.customHue,
  };
}

export async function GET() {
  try {
    await requireAdmin();
    const active = await getActiveTheme();
    return jsonOk({
      activeTheme: active.id,
      themes: await Promise.all(Object.values(themes).map(themeOption)),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const bodySchema = z.object({
  theme: z.string().optional(),
  colorPreset: z.string(),
  customHue: z.number().int().min(0).max(359).optional(),
});

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const {
      theme: themeId,
      colorPreset,
      customHue,
    } = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    // 只接受注册表内的主题 id；缺省表示只改当前活动主题的配色。
    if (themeId !== undefined && !isThemeId(themeId)) {
      return jsonError(400, "unknownTheme");
    }
    const theme = themeId !== undefined ? themes[themeId] : await getActiveTheme();
    const isCustom = colorPreset === "custom";
    const isKnownPreset = theme.colorPresets.some((p) => p.id === colorPreset);
    // 只接受预设 id 或 custom；绝不接受任意 CSS 变量名/值。
    if (!isCustom && !isKnownPreset) {
      return jsonError(400, "unknownColorPreset");
    }
    if (isCustom && typeof theme.colorVarsFromHue !== "function") {
      return jsonError(400, "customColorUnsupported");
    }
    if (isCustom && customHue === undefined) {
      return jsonError(400, "customHueRequired");
    }

    const next = await applyThemeUpdate(
      theme,
      { colorPreset, customHue },
      { switchActiveTheme: themeId !== undefined, actor: { type: "admin", id: admin.id } },
    );
    return jsonOk({ theme: theme.id, ...next });
  } catch (err) {
    return handleApiError(err);
  }
}
