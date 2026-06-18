import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getMembershipDetail: vi.fn(),
  listMembershipHistory: vi.fn(),
  suspendMembership: vi.fn(),
  resumeMembership: vi.fn(),
  revokeMembership: vi.fn(),
  extendMembership: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/modules/membership", () => ({
  getMembershipDetail: mocks.getMembershipDetail,
  listMembershipHistory: mocks.listMembershipHistory,
  suspendMembership: mocks.suspendMembership,
  resumeMembership: mocks.resumeMembership,
  revokeMembership: mocks.revokeMembership,
  extendMembership: mocks.extendMembership,
}));

import { POST as extend } from "./extend/route";
import { POST as resume } from "./resume/route";
import { POST as revoke } from "./revoke/route";
import { GET } from "./route";
import { POST as suspend } from "./suspend/route";

const admin = { id: "admin-1", role: "admin" };
const updatedMembership = { id: "membership-1", status: "suspended", version: 2 };

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/admin/memberships/membership-1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function context() {
  return { params: Promise.resolve({ id: "membership-1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(admin);
  mocks.getMembershipDetail.mockResolvedValue({
    membership: updatedMembership,
    tier: { id: "tier-1", name: "Supporter" },
    userEmail: "fan@example.com",
  });
  mocks.listMembershipHistory.mockResolvedValue([{ id: "audit-1", action: "suspend" }]);
  mocks.suspendMembership.mockResolvedValue(updatedMembership);
  mocks.resumeMembership.mockResolvedValue(updatedMembership);
  mocks.revokeMembership.mockResolvedValue(updatedMembership);
  mocks.extendMembership.mockResolvedValue(updatedMembership);
});

describe("admin membership lifecycle routes", () => {
  it.each([
    [401, "authRequired"],
    [403, "adminRequired"],
  ])("requires admin access for detail and every action (%s)", async (status, code) => {
    mocks.requireAdmin.mockRejectedValue(new ApiError(status, code));

    const responses = await Promise.all([
      GET(request({}), context()),
      suspend(request({ reason: "Reason", expectedVersion: 1 }), context()),
      resume(request({ reason: "Reason", expectedVersion: 1 }), context()),
      revoke(request({ reason: "Reason", expectedVersion: 1 }), context()),
      extend(request({ days: 30, expectedVersion: 1 }), context()),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      status,
      status,
      status,
      status,
      status,
    ]);
    expect(mocks.getMembershipDetail).not.toHaveBeenCalled();
    expect(mocks.suspendMembership).not.toHaveBeenCalled();
    expect(mocks.resumeMembership).not.toHaveBeenCalled();
    expect(mocks.revokeMembership).not.toHaveBeenCalled();
    expect(mocks.extendMembership).not.toHaveBeenCalled();
  });

  it("returns membership detail with audit history", async () => {
    const response = await GET(request({}), context());

    expect(response.status).toBe(200);
    expect(mocks.getMembershipDetail).toHaveBeenCalledWith("membership-1");
    expect(mocks.listMembershipHistory).toHaveBeenCalledWith("membership-1");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        userEmail: "fan@example.com",
        history: [{ id: "audit-1", action: "suspend" }],
      },
    });
  });

  it("returns a stable not-found error without querying history", async () => {
    mocks.getMembershipDetail.mockResolvedValue(null);

    const response = await GET(request({}), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "membershipNotFound",
    });
    expect(mocks.listMembershipHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["suspend", suspend, mocks.suspendMembership],
    ["resume", resume, mocks.resumeMembership],
    ["revoke", revoke, mocks.revokeMembership],
  ] as const)("passes version, reason, and admin actor to %s", async (_name, handler, service) => {
    const response = await handler(
      request({ reason: "  lifecycle reason  ", expectedVersion: 1 }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith("membership-1", {
      reason: "lifecycle reason",
      expectedVersion: 1,
      actor: { type: "admin", id: "admin-1" },
    });
  });

  it("passes extension days, version, and admin actor", async () => {
    const response = await extend(request({ days: 45, expectedVersion: 2 }), context());

    expect(response.status).toBe(200);
    expect(mocks.extendMembership).toHaveBeenCalledWith("membership-1", {
      days: 45,
      expectedVersion: 2,
      actor: { type: "admin", id: "admin-1" },
    });
  });

  it.each([
    ["empty reason", suspend, { reason: "  ", expectedVersion: 1 }],
    ["negative version", revoke, { reason: "Reason", expectedVersion: -1 }],
    ["zero extension", extend, { days: 0, expectedVersion: 1 }],
    ["fractional extension", extend, { days: 1.5, expectedVersion: 1 }],
  ] as const)("rejects invalid input: %s", async (_name, handler, body) => {
    const response = await handler(request(body), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("preserves the stale-version conflict code", async () => {
    mocks.suspendMembership.mockRejectedValue(new ApiError(409, "membershipStale"));

    const response = await suspend(request({ reason: "Reason", expectedVersion: 1 }), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "membershipStale",
    });
  });
});
