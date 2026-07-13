import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  readJsonWithLimit: vi.fn(),
  requireUser: vi.fn(),
  getNotificationPreference: vi.fn(),
  setNotificationPreference: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readJsonWithLimit: mocks.readJsonWithLimit,
  };
});
vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/notifications", () => ({
  getNotificationPreference: mocks.getNotificationPreference,
  setNotificationPreference: mocks.setNotificationPreference,
}));

import { GET, PUT } from "./route";

describe("notification preference API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.getNotificationPreference.mockResolvedValue({ newPostEmailEnabled: false, version: 0 });
    mocks.readJsonWithLimit.mockResolvedValue({ newPostEmailEnabled: true });
    mocks.setNotificationPreference.mockResolvedValue({ newPostEmailEnabled: true, version: 1 });
  });

  it("returns the default-off preference view", async () => {
    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { newPostEmailEnabled: false, version: 0 },
    });
    expect(mocks.getNotificationPreference).toHaveBeenCalledWith("user-1");
  });

  it("authenticates before reading an unauthenticated body", async () => {
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await PUT(
      new Request("http://localhost/api/me/notification-preferences", {
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": "999999999" },
        body: "{",
      }) as NextRequest,
    );

    expect(response.status).toBe(401);
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.setNotificationPreference).not.toHaveBeenCalled();
  });
});
