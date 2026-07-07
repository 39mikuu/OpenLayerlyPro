import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  readJsonWithLimit: vi.fn(),
  requireAdmin: vi.fn(),
  applyThemeUpdate: vi.fn(),
  getActiveTheme: vi.fn(),
  getThemeConfig: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readJsonWithLimit: mocks.readJsonWithLimit,
  };
});
vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/theme", () => ({
  applyThemeUpdate: mocks.applyThemeUpdate,
  getActiveTheme: mocks.getActiveTheme,
  getThemeConfig: mocks.getThemeConfig,
  themes: {
    builtin: {
      id: "builtin",
      name: "内置主题",
      colorPresets: [{ id: "neutral", name: "中性", hue: null }],
      colorVarsFromHue: vi.fn(),
    },
  },
}));

import { PUT } from "./route";

function oversizedJsonRequest(): NextRequest {
  return new Request("http://localhost/api/admin/theme", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "content-length": "999999999",
    },
    body: "{",
  }) as NextRequest;
}

describe("admin theme auth-before-body invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.readJsonWithLimit.mockResolvedValue({ colorPreset: "neutral" });
    mocks.getActiveTheme.mockResolvedValue({ id: "builtin" });
    mocks.applyThemeUpdate.mockResolvedValue({ colorPreset: "neutral", customHue: 256 });
  });

  it("returns 401 before reading an unauthenticated oversized PUT body", async () => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await PUT(oversizedJsonRequest());

    expect(response.status).toBe(401);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.getActiveTheme).not.toHaveBeenCalled();
    expect(mocks.getThemeConfig).not.toHaveBeenCalled();
    expect(mocks.applyThemeUpdate).not.toHaveBeenCalled();
  });
});
