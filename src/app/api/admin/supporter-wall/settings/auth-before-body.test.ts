import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  applySupporterWallSettingsUpdate: vi.fn(),
  readJsonWithLimit: vi.fn(),
  requireAdminSession: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return { ...original, readJsonWithLimit: mocks.readJsonWithLimit };
});
vi.mock("@/modules/auth/session", () => ({ requireAdminSession: mocks.requireAdminSession }));
vi.mock("@/modules/supporter-wall", () => ({
  applySupporterWallSettingsUpdate: mocks.applySupporterWallSettingsUpdate,
}));

import { PUT } from "./route";

describe("admin supporter wall settings auth-before-body invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mocks.readJsonWithLimit.mockResolvedValue({ enabled: true, minLevel: null });
    mocks.applySupporterWallSettingsUpdate.mockResolvedValue({ enabled: true, minLevel: null });
  });

  it("returns 401 before reading an unauthenticated oversized PUT body", async () => {
    mocks.requireAdminSession.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await PUT(
      new Request("http://localhost/api/admin/supporter-wall/settings", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": "999999999",
        },
        body: "{",
      }) as NextRequest,
    );

    expect(response.status).toBe(401);
    expect(mocks.requireAdminSession).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.applySupporterWallSettingsUpdate).not.toHaveBeenCalled();
  });
});
