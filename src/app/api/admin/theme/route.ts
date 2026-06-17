import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { getActiveTheme, getThemeConfig, setThemeConfig } from "@/modules/theme";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    const theme = await getActiveTheme();
    const config = await getThemeConfig(theme);
    // 只返回预设 id/name 与 hue 数字，不暴露完整 CSS 变量 map。
    return jsonOk({
      colorPreset: config.colorPreset,
      customHue: config.customHue,
      supportsCustomColor: typeof theme.colorVarsFromHue === "function",
      presets: theme.colorPresets.map((p) => ({ id: p.id, name: p.name })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const bodySchema = z.object({
  colorPreset: z.string(),
  customHue: z.number().int().min(0).max(359).optional(),
});

export async function PUT(req: NextRequest) {
  try {
    await requireAdmin();
    const theme = await getActiveTheme();
    const { colorPreset, customHue } = bodySchema.parse(await req.json());
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

    const current = await getThemeConfig(theme);
    const next = { colorPreset, customHue: customHue ?? current.customHue };
    await setThemeConfig(next);
    return jsonOk(next);
  } catch (err) {
    return handleApiError(err);
  }
}
