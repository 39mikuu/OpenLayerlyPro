import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireAdminSession: vi.fn(),
  clearSessionCookie: vi.fn(),
  listMySessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  changeAdminPassword: vi.fn(),
  changeAdminEmail: vi.fn(),
  listAdminAuditHistory: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({
  requireAdmin: mocks.requireAdmin,
  requireAdminSession: mocks.requireAdminSession,
  clearSessionCookie: mocks.clearSessionCookie,
}));
vi.mock("@/modules/auth/admin-account", () => ({
  listMySessions: mocks.listMySessions,
  revokeSession: mocks.revokeSession,
  revokeOtherSessions: mocks.revokeOtherSessions,
  changeAdminPassword: mocks.changeAdminPassword,
  changeAdminEmail: mocks.changeAdminEmail,
  listAdminAuditHistory: mocks.listAdminAuditHistory,
}));

import { POST as changeEmail } from "./email/route";
import { GET as history } from "./history/route";
import { POST as changePassword } from "./password/route";
import { DELETE as revokeOne } from "./sessions/[id]/route";
import { POST as revokeOthers } from "./sessions/revoke-others/route";
import { GET as sessions } from "./sessions/route";

const admin = { id: "11111111-1111-4111-8111-111111111111", role: "admin" };

function request(method: string, body?: unknown): NextRequest {
  return new Request("http://localhost/api/admin/account", {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function context() {
  return { params: Promise.resolve({ id: "22222222-2222-4222-8222-222222222222" }) };
}

describe("admin account routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(admin);
    mocks.requireAdminSession.mockResolvedValue({ user: admin, tokenHash: "current-hash" });
    mocks.listMySessions.mockResolvedValue([]);
    mocks.revokeSession.mockResolvedValue({ current: false });
    mocks.revokeOtherSessions.mockResolvedValue(2);
    mocks.changeAdminPassword.mockResolvedValue({ revokedSessions: 2 });
    mocks.changeAdminEmail.mockResolvedValue({ email: "new@example.com" });
    mocks.listAdminAuditHistory.mockResolvedValue([]);
  });

  it.each([
    [401, "authRequired"],
    [403, "adminRequired"],
  ])("requires admin access for every endpoint (%s)", async (status, code) => {
    const error = new ApiError(status, code);
    mocks.requireAdmin.mockRejectedValue(error);
    mocks.requireAdminSession.mockRejectedValue(error);

    const responses = await Promise.all([
      sessions(),
      revokeOne(request("DELETE"), context()),
      revokeOthers(),
      changePassword(
        request("POST", {
          currentPassword: "current-password",
          newPassword: "new-password",
        }),
      ),
      changeEmail(
        request("POST", {
          currentPassword: "current-password",
          newEmail: "new@example.com",
        }),
      ),
      history(),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      status,
      status,
      status,
      status,
      status,
      status,
    ]);
  });

  it("passes the current token hash to session and password services", async () => {
    await sessions();
    await revokeOne(request("DELETE"), context());
    await revokeOthers();
    await changePassword(
      request("POST", {
        currentPassword: "current-password",
        newPassword: "new-password",
      }),
    );

    expect(mocks.listMySessions).toHaveBeenCalledWith(admin.id, "current-hash");
    expect(mocks.revokeSession).toHaveBeenCalledWith(
      admin.id,
      "22222222-2222-4222-8222-222222222222",
      "current-hash",
    );
    expect(mocks.revokeOtherSessions).toHaveBeenCalledWith(admin.id, "current-hash");
    expect(mocks.changeAdminPassword).toHaveBeenCalledWith(admin.id, {
      currentPassword: "current-password",
      newPassword: "new-password",
      currentTokenHash: "current-hash",
    });
  });

  it("clears the cookie when the current session is revoked", async () => {
    mocks.revokeSession.mockResolvedValue({ current: true });

    const response = await revokeOne(request("DELETE"), context());

    expect(response.status).toBe(200);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
  });

  it("updates email and returns account history", async () => {
    const emailResponse = await changeEmail(
      request("POST", {
        currentPassword: "current-password",
        newEmail: "new@example.com",
      }),
    );
    const historyResponse = await history();

    expect(emailResponse.status).toBe(200);
    expect(mocks.changeAdminEmail).toHaveBeenCalledWith(admin.id, {
      currentPassword: "current-password",
      newEmail: "new@example.com",
    });
    expect(historyResponse.status).toBe(200);
    expect(mocks.listAdminAuditHistory).toHaveBeenCalledWith(admin.id);
  });

  it("returns the stable password-too-short error from the service", async () => {
    mocks.changeAdminPassword.mockRejectedValueOnce(
      new ApiError(400, "passwordTooShort", { min: 8 }),
    );

    const response = await changePassword(
      request("POST", { currentPassword: "current-password", newPassword: "short" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "passwordTooShort",
      params: { min: 8 },
    });
    expect(mocks.changeAdminPassword).toHaveBeenCalledWith(admin.id, {
      currentPassword: "current-password",
      newPassword: "short",
      currentTokenHash: "current-hash",
    });
  });
});
