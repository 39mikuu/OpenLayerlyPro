import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

vi.mock("./store", () => ({
  getStoredGroup: vi.fn(),
  setStoredGroup: vi.fn(),
  deleteStoredGroup: vi.fn(),
}));

const mockedGet = vi.mocked(getStoredGroup);
const mockedSet = vi.mocked(setStoredGroup);
const mockedDelete = vi.mocked(deleteStoredGroup);

describe("saveSmtpConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("密码留空时保留原有 DB 密码", async () => {
    mockedGet.mockResolvedValue({ password: "old-pass", host: "old-host" });
    const { saveSmtpConfig } = await import("./smtp-admin");
    await saveSmtpConfig({ host: "new-host", from: "a@b.com", password: "" });
    expect(mockedSet).toHaveBeenCalledWith(
      "smtp",
      expect.objectContaining({ host: "new-host", from: "a@b.com", password: "old-pass" }),
    );
  });

  it("提供新密码时覆盖", async () => {
    mockedGet.mockResolvedValue({ password: "old-pass" });
    const { saveSmtpConfig } = await import("./smtp-admin");
    await saveSmtpConfig({ host: "h", from: "a@b.com", password: "new-pass" });
    expect(mockedSet).toHaveBeenCalledWith(
      "smtp",
      expect.objectContaining({ password: "new-pass" }),
    );
  });

  it("空字符串字段不落库(回落环境变量)", async () => {
    mockedGet.mockResolvedValue(null);
    const { saveSmtpConfig } = await import("./smtp-admin");
    await saveSmtpConfig({ host: "", user: "", from: "a@b.com" });
    const stored = mockedSet.mock.calls[0][1] as Record<string, unknown>;
    expect(stored).not.toHaveProperty("host");
    expect(stored).not.toHaveProperty("user");
    expect(stored.from).toBe("a@b.com");
  });
});

describe("getSmtpAdminView", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("SMTP_HOST", "env-host");
    vi.stubEnv("SMTP_FROM", "env@b.com");
    vi.stubEnv("SMTP_PASSWORD", "env-pass");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("不泄露密码,只给 passwordSet;hasDbOverride 反映是否有 DB 行", async () => {
    mockedGet.mockResolvedValue({ host: "db-host", password: "db-pass" });
    const { getSmtpAdminView } = await import("./smtp-admin");
    const view = await getSmtpAdminView();
    expect(view).not.toHaveProperty("password");
    expect(view.passwordSet).toBe(true);
    expect(view.hasDbOverride).toBe(true);
    expect(view.host).toBe("db-host"); // DB 覆盖 env
    expect(view.envDefaults.host).toBe("env-host");
    expect(view.envDefaults.passwordSet).toBe(true);
  });

  it("无 DB 行时 hasDbOverride 为 false 且回落环境变量", async () => {
    mockedGet.mockResolvedValue(null);
    const { getSmtpAdminView } = await import("./smtp-admin");
    const view = await getSmtpAdminView();
    expect(view.hasDbOverride).toBe(false);
    expect(view.host).toBe("env-host");
  });
});

describe("clearSmtpConfig", () => {
  it("删除 smtp 配置组", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { clearSmtpConfig } = await import("./smtp-admin");
    await clearSmtpConfig();
    expect(mockedDelete).toHaveBeenCalledWith("smtp");
  });
});
