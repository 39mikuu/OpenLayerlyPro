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

describe("getTurnstileConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("TURNSTILE_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "env-site");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "env-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("DB 无记录时回落环境变量", async () => {
    mockedGet.mockResolvedValue(null);
    const { getTurnstileConfig } = await import("./turnstile");
    await expect(getTurnstileConfig()).resolves.toEqual({
      enabled: false,
      siteKey: "env-site",
      secretKey: "env-secret",
    });
  });

  it("后台 enabled=false 能覆盖 env TURNSTILE_ENABLED=true", async () => {
    vi.stubEnv("TURNSTILE_ENABLED", "true");
    mockedGet.mockResolvedValue({ enabled: false });
    const { getTurnstileConfig } = await import("./turnstile");
    const config = await getTurnstileConfig();
    expect(config.enabled).toBe(false);
    expect(config.siteKey).toBe("env-site");
    expect(config.secretKey).toBe("env-secret");
  });

  it("后台 enabled=true 能覆盖 env TURNSTILE_ENABLED=false", async () => {
    mockedGet.mockResolvedValue({
      enabled: true,
      siteKey: "db-site",
      secretKey: "db-secret",
    });
    const { getTurnstileConfig } = await import("./turnstile");
    await expect(getTurnstileConfig()).resolves.toEqual({
      enabled: true,
      siteKey: "db-site",
      secretKey: "db-secret",
    });
  });

  it("DB 空字符串不截断 env fallback", async () => {
    mockedGet.mockResolvedValue({ siteKey: "  ", secretKey: "" });
    const { getTurnstileConfig } = await import("./turnstile");
    const config = await getTurnstileConfig();
    expect(config.siteKey).toBe("env-site");
    expect(config.secretKey).toBe("env-secret");
  });
});

describe("Turnstile 后台读写", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("TURNSTILE_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("admin view 不泄露 secretKey", async () => {
    mockedGet.mockResolvedValue({
      enabled: true,
      siteKey: "db-site",
      secretKey: "db-secret",
    });
    const { getTurnstileAdminView } = await import("./turnstile");
    const view = await getTurnstileAdminView();
    expect(view).not.toHaveProperty("secretKey");
    expect(view.secretKeySet).toBe(true);
    expect(view.hasDbOverride).toBe(true);
    expect(view.siteKey).toBe("db-site");
  });

  it("effective enabled=true 且缺密钥时拒绝保存", async () => {
    mockedGet.mockResolvedValue(null);
    const { saveTurnstileConfig } = await import("./turnstile");
    await expect(saveTurnstileConfig({ enabled: true })).rejects.toMatchObject({
      status: 400,
    });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("enabled=false 时允许密钥为空且 false 会落库", async () => {
    vi.stubEnv("TURNSTILE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "env-site");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "env-secret");
    mockedGet.mockResolvedValue(null);
    const { saveTurnstileConfig } = await import("./turnstile");
    await saveTurnstileConfig({ enabled: false, siteKey: "", secretKey: "" });
    expect(mockedSet).toHaveBeenCalledWith("turnstile", { enabled: false });
  });

  it("siteKey 与新 secretKey 保存前 trim", async () => {
    mockedGet.mockResolvedValue(null);
    const { saveTurnstileConfig } = await import("./turnstile");
    await saveTurnstileConfig({
      enabled: true,
      siteKey: "  db-site  ",
      secretKey: "  db-secret  ",
    });
    expect(mockedSet).toHaveBeenCalledWith("turnstile", {
      enabled: true,
      siteKey: "db-site",
      secretKey: "db-secret",
    });
  });

  it("siteKey 空字符串不落库并回退 env,secretKey 空字符串保留旧值", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "env-site");
    mockedGet.mockResolvedValue({
      enabled: true,
      siteKey: "old-site",
      secretKey: "old-secret",
    });
    const { saveTurnstileConfig } = await import("./turnstile");
    await saveTurnstileConfig({ enabled: true, siteKey: " ", secretKey: " " });
    expect(mockedSet).toHaveBeenCalledWith("turnstile", {
      enabled: true,
      secretKey: "old-secret",
    });
  });

  it("清除配置组后回落环境变量", async () => {
    const { clearTurnstileConfig } = await import("./turnstile");
    await clearTurnstileConfig();
    expect(mockedDelete).toHaveBeenCalledWith("turnstile");
  });
});
