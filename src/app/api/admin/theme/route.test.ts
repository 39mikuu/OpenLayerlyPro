import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/modules/auth/session";
import { getT } from "@/modules/i18n/server";
import { applyThemeUpdate, getActiveTheme, getThemeConfig } from "@/modules/theme";

import { GET, PUT } from "./route";

const builtin = {
  id: "builtin",
  nameKey: "admin.site.themeNames.builtin",
  colorPresets: [
    { id: "neutral", nameKey: "admin.site.colorPresetNames.neutral", kind: "none" },
    { id: "blue", nameKey: "admin.site.colorPresetNames.blue", kind: "hue", hue: 256 },
  ],
  colorVarsFromHue: vi.fn(),
};

const wordpress = {
  id: "wordpress",
  nameKey: "admin.site.themeNames.wordpress",
  colorPresets: [
    {
      id: "gofun-seiji",
      nameKey: "admin.site.colorPresetNames.gofunSeiji",
      kind: "vars",
      cssVars: {
        light: { "--primary": "oklch(0.52 0.09 195)" },
        dark: { "--primary": "oklch(0.72 0.10 190)" },
      },
    },
    {
      id: "layer-seal",
      nameKey: "admin.site.colorPresetNames.layerSeal",
      kind: "vars",
      cssVars: {
        light: { "--wordpress-seal": "oklch(0.53 0.17 18)" },
        dark: { "--wordpress-seal": "oklch(0.70 0.15 18)" },
      },
    },
  ],
};

vi.mock("@/modules/auth/session", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/modules/i18n/server", () => ({ getT: vi.fn() }));
vi.mock("@/modules/theme", () => ({
  applyThemeUpdate: vi.fn(),
  getActiveTheme: vi.fn(),
  getThemeConfig: vi.fn(),
  themes: {
    builtin: {
      id: "builtin",
      nameKey: "admin.site.themeNames.builtin",
      colorPresets: [
        { id: "neutral", nameKey: "admin.site.colorPresetNames.neutral", kind: "none" },
        { id: "blue", nameKey: "admin.site.colorPresetNames.blue", kind: "hue", hue: 256 },
      ],
      colorVarsFromHue: vi.fn(),
    },
    blog: {
      id: "blog",
      nameKey: "admin.site.themeNames.blog",
      colorPresets: [
        { id: "ink", nameKey: "admin.site.colorPresetNames.ink", kind: "none" },
        { id: "indigo", nameKey: "admin.site.colorPresetNames.indigo", kind: "hue", hue: 275 },
      ],
      colorVarsFromHue: vi.fn(),
    },
    wordpress: {
      id: "wordpress",
      nameKey: "admin.site.themeNames.wordpress",
      colorPresets: [
        {
          id: "gofun-seiji",
          nameKey: "admin.site.colorPresetNames.gofunSeiji",
          kind: "vars",
          cssVars: {
            light: { "--primary": "oklch(0.52 0.09 195)" },
            dark: { "--primary": "oklch(0.72 0.10 190)" },
          },
        },
        {
          id: "layer-seal",
          nameKey: "admin.site.colorPresetNames.layerSeal",
          kind: "vars",
          cssVars: {
            light: { "--wordpress-seal": "oklch(0.53 0.17 18)" },
            dark: { "--wordpress-seal": "oklch(0.70 0.15 18)" },
          },
        },
      ],
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
    data?: unknown;
    error?: string;
  }>;
}

describe("GET /api/admin/theme", () => {
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
    vi.mocked(getActiveTheme).mockResolvedValue(wordpress as never);
    vi.mocked(getT).mockResolvedValue(
      ((key: string) =>
        ({
          "admin.site.themeNames.builtin": "Built-in theme",
          "admin.site.themeNames.blog": "Blog theme",
          "admin.site.themeNames.wordpress": "WordPress Classic",
          "admin.site.colorPresetNames.neutral": "Neutral",
          "admin.site.colorPresetNames.blue": "Blue",
          "admin.site.colorPresetNames.ink": "Ink",
          "admin.site.colorPresetNames.indigo": "Indigo",
          "admin.site.colorPresetNames.gofunSeiji": "Gofun × Ink × Seiji",
          "admin.site.colorPresetNames.layerSeal": "Layer Seal",
        })[key] ?? key) as never,
    );
    vi.mocked(getThemeConfig).mockImplementation(async (theme: { id: string }) => {
      if (theme.id === "wordpress") return { colorPreset: "gofun-seiji", customHue: 0 };
      if (theme.id === "blog") return { colorPreset: "ink", customHue: 275 };
      return { colorPreset: "blue", customHue: 256 };
    });
  });

  it("returns three themes without leaking exact cssVars", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await responseBody(response);
    expect(body).toMatchObject({ ok: true });
    expect(JSON.stringify(body)).toContain("wordpress");
    expect(JSON.stringify(body)).toContain("gofun-seiji");
    expect(JSON.stringify(body)).toContain("WordPress Classic");
    expect(JSON.stringify(body)).toContain("Layer Seal");
    expect(JSON.stringify(body)).not.toContain("cssVars");
    expect(JSON.stringify(body)).not.toContain("--wordpress-seal");
  });
});

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

  it.each(["gofun-seiji", "layer-seal"])("accepts wordpress preset %s", async (colorPreset) => {
    vi.mocked(applyThemeUpdate).mockResolvedValue({ colorPreset, customHue: 0 });

    const response = await PUT(request({ theme: "wordpress", colorPreset }));

    expect(response.status).toBe(200);
    expect(applyThemeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wordpress" }),
      { colorPreset, customHue: undefined },
      expect.objectContaining({ switchActiveTheme: true }),
    );
  });

  it("rejects wordpress custom colors", async () => {
    const response = await PUT(
      request({ theme: "wordpress", colorPreset: "custom", customHue: 42 }),
    );

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({ ok: false });
    expect(applyThemeUpdate).not.toHaveBeenCalled();
  });

  it("rejects presets that belong to a different theme when switching", async () => {
    const response = await PUT(request({ theme: "blog", colorPreset: "blue" }));

    expect(response.status).toBe(400);
    expect(applyThemeUpdate).not.toHaveBeenCalled();
  });
});
