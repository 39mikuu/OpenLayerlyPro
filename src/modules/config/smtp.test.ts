import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStoredGroup } from "./store";

vi.mock("./store", () => ({
  getStoredGroup: vi.fn(),
}));

const mockedGetStored = vi.mocked(getStoredGroup);

describe("getSmtpConfig 解析优先级", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SMTP_HOST", "env-host");
    vi.stubEnv("SMTP_PORT", "2525");
    vi.stubEnv("SMTP_FROM", "env@example.com");
    vi.stubEnv("SMTP_USER", "env-user");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("DB 无记录时全程回落环境变量", async () => {
    mockedGetStored.mockResolvedValue(null);
    const { getSmtpConfig } = await import("./smtp");
    const cfg = await getSmtpConfig();
    expect(cfg.host).toBe("env-host");
    expect(cfg.port).toBe(2525);
    expect(cfg.from).toBe("env@example.com");
    expect(cfg.configured).toBe(true);
  });

  it("DB 值覆盖环境变量,未设置字段仍回落 env", async () => {
    mockedGetStored.mockResolvedValue({ host: "db-host", from: "db@example.com" });
    const { getSmtpConfig } = await import("./smtp");
    const cfg = await getSmtpConfig();
    expect(cfg.host).toBe("db-host");
    expect(cfg.from).toBe("db@example.com");
    // 未在 DB 设置 → 回落 env
    expect(cfg.port).toBe(2525);
    expect(cfg.user).toBe("env-user");
  });

  it("host 或 from 缺失时 configured 为 false", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SMTP_HOST", "only-host");
    mockedGetStored.mockResolvedValue(null);
    const { getSmtpConfig } = await import("./smtp");
    const cfg = await getSmtpConfig();
    expect(cfg.configured).toBe(false);
  });
});
