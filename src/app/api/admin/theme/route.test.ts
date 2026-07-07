import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/modules/auth/session";
import { applyThemeUpdate, getActiveTheme } from "@/modules/theme";

import { PUT } from "./route";

const builtin = {
  id: "builtin",
  name: "内置主题",
  colorPresets: [
    { id: "neutral", name: "中性", hue: null },
    { id: "blue", name: "蓝", hue: 256 },
  ],
  colorVarsFromHue: vi.fn(),
};

vi.mock("@/modules/auth/session", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/modules/theme", () => ({
  applyThemeUpdate: vi.fn(),
  getActiveTheme: vi.fn(),
  getThemeConfig: vi.fn(),
  themes: {
    builtin: {
      id: "builtin",
      name: "内置主题",
      colorPresets: [
        { id: "neutral", name: "中性", hue: null },
        { id: "blue", name: "蓝", hue: 256 },
      ],
      colorVarsFromHue: vi.fn(),
    },
    blog: {
      id: "blog",
      name: "博客主题",
      colorPresets: [
        { id: "ink", name: "墨", hue: null },
        { id: "indigo", name: "靛蓝", hue: 275 },
      ],
      colorVarsFromHue: vi.fn(),
    },
  },
}));

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/admin/theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function responseBody(response: Response) {
  return response.json() as Promise<{
    ok: boolean;
    data?: { theme: string; colorPreset: string; customHue: number };
    error?: string;
  }>;
}

describe("PUT /api/admin/theme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "admin@example.com",
      passwordHash: null,
      displayName: null,
      role: "admin",
      locale: "zh",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastLoginAt: null,
    });
    vi.mocked(getActiveTheme).mockResolvedValue(builtin as never);
    vi.mocked(applyThemeUpdate).mockResolvedValue({ colorPreset: "neutral", customHue: 256 });
  });

  it("rejects unknown presets", async () => {
    const response = await PUT(request({ colorPreset: "not-a-preset", customHue: 42 }));

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({ ok: false });
    expect(applyThemeUpdate).not.toHaveBeenCalled();
  });

  it("rejects unknown theme ids", async () => {
    const response = await PUT(request({ theme: "not-a-theme", colorPreset: "neutral" }));

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({ ok: false, error: "未知的主题" });
    expect(applyThemeUpdate).not.toHaveBeenCalled();
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "rejects inherited object property theme id %s",
    async (theme) => {
      const response = await PUT(request({ theme, colorPreset: "neutral" }));

      expect(response.status).toBe(400);
      expect(await responseBody(response)).toMatchObject({
        ok: false,
        error: "未知的主题",
      });
      expect(applyThemeUpdate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "missing hue", body: { colorPreset: "custom" } },
    { label: "out-of-range hue", body: { colorPreset: "custom", customHue: 360 } },
    { label: "non-integer hue", body: { colorPreset: "custom", customHue: 12.5 } },
    { label: "non-number hue", body: { colorPreset: "custom", customHue: "12" } },
  ])("rejects invalid custom input: $label", async ({ body }) => {
    const response = await PUT(request(body));

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({ ok: false });
    expect(applyThemeUpdate).not.toHaveBeenCalled();
  });

  it("stores only the selected id and numeric hue for custom colors", async () => {
    vi.mocked(applyThemeUpdate).mockResolvedValue({ colorPreset: "custom", customHue: 42 });

    const response = await PUT(request({ colorPreset: "custom", customHue: 42 }));

    expect(response.status).toBe(200);
    expect(applyThemeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "builtin" }),
      { colorPreset: "custom", customHue: 42 },
      {
        switchActiveTheme: false,
        actor: { type: "admin", id: "00000000-0000-4000-8000-000000000001" },
      },
    );
    // 未提交 theme 字段：只改配色，不写活动主题。
    expect(await responseBody(response)).toEqual({
      ok: true,
      data: { theme: "builtin", colorPreset: "custom", customHue: 42 },
    });
  });

  it("lets the transactional updater preserve the previous custom hue when saving a named preset", async () => {
    vi.mocked(applyThemeUpdate).mockResolvedValue({ colorPreset: "blue", customHue: 42 });

    const response = await PUT(request({ colorPreset: "blue" }));

    expect(response.status).toBe(200);
    expect(applyThemeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "builtin" }),
      { colorPreset: "blue", customHue: undefined },
      expect.objectContaining({ switchActiveTheme: false }),
    );
    expect(await responseBody(response)).toEqual({
      ok: true,
      data: { theme: "builtin", colorPreset: "blue", customHue: 42 },
    });
  });

  it("switches the active theme and validates presets against the target theme", async () => {
    vi.mocked(applyThemeUpdate).mockResolvedValue({ colorPreset: "indigo", customHue: 275 });

    const response = await PUT(request({ theme: "blog", colorPreset: "indigo" }));

    expect(response.status).toBe(200);
    expect(applyThemeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "blog" }),
      { colorPreset: "indigo", customHue: undefined },
      {
        switchActiveTheme: true,
        actor: { type: "admin", id: "00000000-0000-4000-8000-000000000001" },
      },
    );
    expect(await responseBody(response)).toEqual({
      ok: true,
      data: { theme: "blog", colorPreset: "indigo", customHue: 275 },
    });
  });

  it("rejects presets that belong to a different theme when switching", async () => {
    const response = await PUT(request({ theme: "blog", colorPreset: "blue" }));

    expect(response.status).toBe(400);
    expect(applyThemeUpdate).not.toHaveBeenCalled();
  });
});
