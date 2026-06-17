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

describe("getStorageConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("STORAGE_DRIVER", "local");
    vi.stubEnv("S3_ENDPOINT", "https://env.example.com");
    vi.stubEnv("S3_REGION", "auto");
    vi.stubEnv("S3_BUCKET", "env-bucket");
    vi.stubEnv("S3_ACCESS_KEY_ID", "env-access");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "env-secret");
    vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("DB 无记录时回落环境变量", async () => {
    mockedGet.mockResolvedValue(null);
    const { getStorageConfig } = await import("./storage");
    await expect(getStorageConfig()).resolves.toEqual({
      driver: "local",
      endpoint: "https://env.example.com",
      region: "auto",
      bucket: "env-bucket",
      accessKeyId: "env-access",
      secretAccessKey: "env-secret",
      forcePathStyle: true,
      s3Configured: true,
    });
  });

  it("后台 local 能覆盖 env s3", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    mockedGet.mockResolvedValue({ driver: "local" });
    const { getStorageConfig } = await import("./storage");
    expect((await getStorageConfig()).driver).toBe("local");
  });

  it("后台 s3 能覆盖 env local", async () => {
    mockedGet.mockResolvedValue({ driver: "s3" });
    const { getStorageConfig } = await import("./storage");
    const config = await getStorageConfig();
    expect(config.driver).toBe("s3");
    expect(config.s3Configured).toBe(true);
  });

  it("空字符串不截断 env fallback，region 空值回落 env", async () => {
    mockedGet.mockResolvedValue({
      endpoint: " ",
      region: "",
      bucket: " ",
      accessKeyId: "",
      secretAccessKey: " ",
    });
    const { getStorageConfig } = await import("./storage");
    const config = await getStorageConfig();
    expect(config.endpoint).toBe("https://env.example.com");
    expect(config.region).toBe("auto");
    expect(config.bucket).toBe("env-bucket");
    expect(config.accessKeyId).toBe("env-access");
    expect(config.secretAccessKey).toBe("env-secret");
  });
});

describe("Storage 后台读写", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("STORAGE_DRIVER", "local");
    vi.stubEnv("S3_ENDPOINT", "");
    vi.stubEnv("S3_REGION", "auto");
    vi.stubEnv("S3_BUCKET", "");
    vi.stubEnv("S3_ACCESS_KEY_ID", "");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "");
    vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("admin view 不泄露两个敏感字段", async () => {
    mockedGet.mockResolvedValue({
      driver: "s3",
      endpoint: "https://db.example.com",
      region: "auto",
      bucket: "db-bucket",
      accessKeyId: "db-access",
      secretAccessKey: "db-secret",
    });
    const { getStorageAdminView } = await import("./storage");
    const view = await getStorageAdminView();
    expect(view).not.toHaveProperty("accessKeyId");
    expect(view).not.toHaveProperty("secretAccessKey");
    expect(view.accessKeyIdSet).toBe(true);
    expect(view.secretAccessKeySet).toBe(true);
    expect(view.hasDbOverride).toBe(true);
  });

  it("最终 driver=s3 且配置不完整时拒绝保存", async () => {
    mockedGet.mockResolvedValue(null);
    const { saveStorageConfig } = await import("./storage");
    await expect(saveStorageConfig({ driver: "s3" })).rejects.toMatchObject({ status: 400 });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("driver=local 时允许 S3 字段为空", async () => {
    mockedGet.mockResolvedValue(null);
    const { saveStorageConfig } = await import("./storage");
    await saveStorageConfig({
      driver: "local",
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(mockedSet).toHaveBeenCalledWith("storage", { driver: "local" });
  });

  it("普通字段 trim，region 显式 auto 会落库", async () => {
    mockedGet.mockResolvedValue(null);
    const { saveStorageConfig } = await import("./storage");
    await saveStorageConfig({
      driver: "s3",
      endpoint: "  https://db.example.com  ",
      region: "  auto  ",
      bucket: "  db-bucket  ",
      accessKeyId: "  db-access  ",
      secretAccessKey: "  db-secret  ",
      forcePathStyle: false,
    });
    expect(mockedSet).toHaveBeenCalledWith("storage", {
      driver: "s3",
      endpoint: "https://db.example.com",
      region: "auto",
      bucket: "db-bucket",
      accessKeyId: "db-access",
      secretAccessKey: "db-secret",
      forcePathStyle: false,
    });
  });

  it("普通字段空值回落 env，两个凭据空值保留旧 DB 值", async () => {
    vi.stubEnv("S3_ENDPOINT", "https://env.example.com");
    vi.stubEnv("S3_REGION", "env-region");
    vi.stubEnv("S3_BUCKET", "env-bucket");
    mockedGet.mockResolvedValue({
      driver: "s3",
      endpoint: "old-endpoint",
      region: "old-region",
      bucket: "old-bucket",
      accessKeyId: "old-access",
      secretAccessKey: "old-secret",
    });
    const { saveStorageConfig } = await import("./storage");
    await saveStorageConfig({
      driver: "s3",
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyId: " ",
      secretAccessKey: " ",
    });
    expect(mockedSet).toHaveBeenCalledWith("storage", {
      driver: "s3",
      accessKeyId: "old-access",
      secretAccessKey: "old-secret",
    });
  });

  it("清除配置组后回落环境变量", async () => {
    const { clearStorageConfig } = await import("./storage");
    await clearStorageConfig();
    expect(mockedDelete).toHaveBeenCalledWith("storage");
  });
});
