import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  readJsonWithLimit: vi.fn(),
  requireUser: vi.fn(),
  upsertOptIn: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return { ...original, readJsonWithLimit: mocks.readJsonWithLimit };
});
vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/supporter-wall", () => ({
  getMyWallEntry: vi.fn(),
  optOut: vi.fn(),
  upsertOptIn: mocks.upsertOptIn,
}));

import { PUT } from "./route";

describe("supporter wall fan API auth-before-body invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.readJsonWithLimit.mockResolvedValue({ dedication: "Thanks" });
    mocks.upsertOptIn.mockResolvedValue({ id: "entry-1" });
  });

  it("returns 401 before reading an unauthenticated oversized PUT body", async () => {
    mocks.requireUser.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await PUT(
      new Request("http://localhost/api/me/supporter-wall", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": "999999999",
        },
        body: "{",
      }) as NextRequest,
    );

    expect(response.status).toBe(401);
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.upsertOptIn).not.toHaveBeenCalled();
  });
});
