import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  changeAdminPassword: vi.fn(),
  readJsonWithLimit: vi.fn(),
  requireAdminSession: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return {
    ...original,
    readJsonWithLimit: mocks.readJsonWithLimit,
  };
});
vi.mock("@/modules/auth/admin-account", () => ({
  changeAdminPassword: mocks.changeAdminPassword,
}));
vi.mock("@/modules/auth/session", () => ({
  requireAdminSession: mocks.requireAdminSession,
}));

import { POST } from "./route";

describe("admin password auth-before-body invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      tokenHash: "current-token",
    });
    mocks.readJsonWithLimit.mockResolvedValue({
      currentPassword: "current-password",
      newPassword: "new-password",
    });
    mocks.changeAdminPassword.mockResolvedValue({ revokedSessions: 1 });
  });

  it("returns 401 before reading a requireAdminSession JSON body", async () => {
    mocks.requireAdminSession.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(
      new Request("http://localhost/api/admin/account/password", {
        method: "POST",
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
    expect(mocks.changeAdminPassword).not.toHaveBeenCalled();
  });
});
