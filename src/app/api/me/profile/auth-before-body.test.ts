import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  readJsonWithLimit: vi.fn(),
  requireUser: vi.fn(),
  updateUserDisplayNameWithWallReset: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return { ...original, readJsonWithLimit: mocks.readJsonWithLimit };
});
vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/supporter-wall", () => ({
  updateUserDisplayNameWithWallReset: mocks.updateUserDisplayNameWithWallReset,
}));

import { PATCH } from "./route";

function oversizedRequest(): NextRequest {
  return new Request("http://localhost/api/me/profile", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "content-length": "999999999",
    },
    body: "{",
  }) as NextRequest;
}

describe("profile auth-before-body invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.readJsonWithLimit.mockResolvedValue({ displayName: "Fan" });
    mocks.updateUserDisplayNameWithWallReset.mockResolvedValue(undefined);
  });

  it("returns 401 before reading an unauthenticated oversized PATCH body", async () => {
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await PATCH(oversizedRequest());

    expect(response.status).toBe(401);
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.updateUserDisplayNameWithWallReset).not.toHaveBeenCalled();
  });
});
