import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  verifyPassword: vi.fn(),
  recordEvent: vi.fn(),
  touchLastLogin: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/crypto", () => ({ verifyPassword: mocks.verifyPassword }));
vi.mock("@/modules/system/events", () => ({ recordEvent: mocks.recordEvent }));
vi.mock("@/modules/user", () => ({ touchLastLogin: mocks.touchLastLogin }));

import { adminLogin } from "./admin-login";

function mockUsers(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  mocks.getDb.mockReturnValue({ select: vi.fn(() => ({ from })) });
}

describe("adminLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyPassword.mockResolvedValue(false);
    mocks.touchLastLogin.mockResolvedValue(undefined);
    mocks.recordEvent.mockResolvedValue(undefined);
  });

  it.each([
    ["missing account", []],
    [
      "non-admin account",
      [{ id: "user-1", email: "fan@example.test", role: "user", passwordHash: "user-hash" }],
    ],
    [
      "admin without password",
      [{ id: "user-1", email: "admin@example.test", role: "admin", passwordHash: null }],
    ],
  ])("runs one cost-12 bcrypt comparison for a %s", async (_label, rows) => {
    mockUsers(rows);

    await expect(adminLogin("ADMIN@example.test", "guess")).rejects.toMatchObject({
      status: 401,
      code: "invalidCredentials",
    });

    expect(mocks.verifyPassword).toHaveBeenCalledOnce();
    expect(mocks.verifyPassword).toHaveBeenCalledWith(
      "guess",
      expect.stringMatching(/^\$2b\$12\$/),
    );
    expect(mocks.touchLastLogin).not.toHaveBeenCalled();
  });

  it("uses the stored hash and records a successful admin login", async () => {
    const user = {
      id: "admin-1",
      email: "admin@example.test",
      role: "admin",
      passwordHash: "$2b$12$stored-admin-hash",
    };
    mockUsers([user]);
    mocks.verifyPassword.mockResolvedValue(true);

    await expect(adminLogin(" ADMIN@example.test ", "correct")).resolves.toBe(user);

    expect(mocks.verifyPassword).toHaveBeenCalledWith("correct", user.passwordHash);
    expect(mocks.touchLastLogin).toHaveBeenCalledWith(user.id);
    expect(mocks.recordEvent).toHaveBeenCalledWith("admin_login", { userId: user.id });
  });
});
