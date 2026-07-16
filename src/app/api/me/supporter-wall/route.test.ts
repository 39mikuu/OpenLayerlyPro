import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMyWallEntry: vi.fn(),
  optOut: vi.fn(),
  requireUser: vi.fn(),
  upsertOptIn: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/modules/supporter-wall", () => ({
  getMyWallEntry: mocks.getMyWallEntry,
  optOut: mocks.optOut,
  upsertOptIn: mocks.upsertOptIn,
}));

import { DELETE, GET, PUT } from "./route";

function jsonRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/me/supporter-wall", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe("/api/me/supporter-wall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.getMyWallEntry.mockResolvedValue(null);
    mocks.upsertOptIn.mockResolvedValue({
      id: "entry-1",
      dedication: "Thanks",
      status: "pending",
      version: 1,
    });
    mocks.optOut.mockResolvedValue({ deleted: true });
  });

  it("returns the authenticated fan entry", async () => {
    mocks.getMyWallEntry.mockResolvedValue({ id: "entry-1", dedication: null });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { entry: { id: "entry-1", dedication: null } },
    });
    expect(mocks.getMyWallEntry).toHaveBeenCalledWith("user-1");
  });

  it("upserts a bounded dedication for the authenticated fan", async () => {
    const response = await PUT(jsonRequest({ dedication: "Thanks" }));

    expect(response.status).toBe(200);
    expect(mocks.upsertOptIn).toHaveBeenCalledWith({
      userId: "user-1",
      dedication: "Thanks",
    });
  });

  it("rejects overlong dedications before calling the domain module", async () => {
    const response = await PUT(jsonRequest({ dedication: "x".repeat(201) }));

    expect(response.status).toBe(400);
    expect(mocks.upsertOptIn).not.toHaveBeenCalled();
  });

  it("deletes the authenticated fan entry without reading a body", async () => {
    const response = await DELETE();

    expect(response.status).toBe(200);
    expect(mocks.optOut).toHaveBeenCalledWith({ userId: "user-1" });
  });
});
