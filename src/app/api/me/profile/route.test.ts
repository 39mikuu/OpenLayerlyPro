import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateUserDisplayName: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/user", () => ({ updateUserDisplayName: mocks.updateUserDisplayName }));

import { PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/me/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe("PATCH /api/me/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.updateUserDisplayName.mockResolvedValue(undefined);
  });

  it("trims and persists a bounded display name", async () => {
    const response = await PATCH(request({ displayName: "  Fan Name  " }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { displayName: "Fan Name" },
    });
    expect(mocks.updateUserDisplayName).toHaveBeenCalledWith("user-1", "Fan Name");
  });

  it("clears the display name on explicit null", async () => {
    const response = await PATCH(request({ displayName: null }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { displayName: null } });
    expect(mocks.updateUserDisplayName).toHaveBeenCalledWith("user-1", null);
  });

  it.each([
    ["whitespace", { displayName: "   " }],
    ["too long", { displayName: "x".repeat(51) }],
    ["missing", {}],
    ["non-string", { displayName: 123 }],
  ])("rejects %s displayName payloads", async (_name, body) => {
    const response = await PATCH(request(body));

    expect(response.status).toBe(400);
    expect(mocks.updateUserDisplayName).not.toHaveBeenCalled();
  });
});
