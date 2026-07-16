import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  approveSupporterWallEntry: vi.fn(),
  readJsonWithLimit: vi.fn(),
  requireAdminSession: vi.fn(),
}));

vi.mock("@/lib/request-body", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/request-body")>();
  return { ...original, readJsonWithLimit: mocks.readJsonWithLimit };
});
vi.mock("@/modules/auth/session", () => ({ requireAdminSession: mocks.requireAdminSession }));
vi.mock("@/modules/supporter-wall", () => ({
  approveSupporterWallEntry: mocks.approveSupporterWallEntry,
}));

import { POST } from "./route";

describe("admin supporter wall approve auth-before-body invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mocks.readJsonWithLimit.mockResolvedValue({ expectedVersion: 1 });
    mocks.approveSupporterWallEntry.mockResolvedValue({ id: "entry-1" });
  });

  it("returns 401 before reading an unauthenticated oversized POST body", async () => {
    mocks.requireAdminSession.mockRejectedValue(new ApiError(401, "authRequired"));

    const response = await POST(
      new Request("http://localhost/api/admin/supporter-wall/entry-1/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999999999",
        },
        body: "{",
      }) as NextRequest,
      { params: Promise.resolve({ id: "entry-1" }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.requireAdminSession).toHaveBeenCalledTimes(1);
    expect(mocks.readJsonWithLimit).not.toHaveBeenCalled();
    expect(mocks.approveSupporterWallEntry).not.toHaveBeenCalled();
  });
});
