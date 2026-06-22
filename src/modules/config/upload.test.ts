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

describe("getUploadConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("MAX_UPLOAD_SIZE_MB", "500");
    vi.stubEnv("PAYMENT_PROOF_MAX_SIZE_MB", "10");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("DB 无记录时回落环境变量", async () => {
    mockedGet.mockResolvedValue(null);
    const { getUploadConfig } = await import("./upload");
    await expect(getUploadConfig()).resolves.toEqual({
      maxUploadSizeMb: 500,
      paymentProofMaxSizeMb: 10,
    });
  });

  it("DB 值覆盖环境变量", async () => {
    mockedGet.mockResolvedValue({ maxUploadSizeMb: 200, paymentProofMaxSizeMb: 5 });
    const { getUploadConfig } = await import("./upload");
    await expect(getUploadConfig()).resolves.toEqual({
      maxUploadSizeMb: 200,
      paymentProofMaxSizeMb: 5,
    });
  });

  it("DB 付款截图配置不能高于部署传输层上限", async () => {
    mockedGet.mockResolvedValue({ paymentProofMaxSizeMb: 50 });
    const { getUploadConfig } = await import("./upload");
    await expect(getUploadConfig()).resolves.toEqual({
      maxUploadSizeMb: 500,
      paymentProofMaxSizeMb: 10,
    });
  });

  it("部分字段缺失时该字段回落 env", async () => {
    mockedGet.mockResolvedValue({ maxUploadSizeMb: 300 });
    const { getUploadConfig } = await import("./upload");
    await expect(getUploadConfig()).resolves.toEqual({
      maxUploadSizeMb: 300,
      paymentProofMaxSizeMb: 10,
    });
  });
});

describe("Upload 后台读写", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("MAX_UPLOAD_SIZE_MB", "500");
    vi.stubEnv("PAYMENT_PROOF_MAX_SIZE_MB", "10");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("admin view 含正确的 hasDbOverride 与 envDefaults", async () => {
    mockedGet.mockResolvedValue({ maxUploadSizeMb: 200 });
    const { getUploadAdminView } = await import("./upload");
    const view = await getUploadAdminView();
    expect(view).toEqual({
      maxUploadSizeMb: 200,
      paymentProofMaxSizeMb: 10,
      hasDbOverride: true,
      envDefaults: { maxUploadSizeMb: 500, paymentProofMaxSizeMb: 10 },
    });
  });

  it("DB 无记录时 hasDbOverride 为 false", async () => {
    mockedGet.mockResolvedValue(null);
    const { getUploadAdminView } = await import("./upload");
    const view = await getUploadAdminView();
    expect(view.hasDbOverride).toBe(false);
    expect(view.maxUploadSizeMb).toBe(500);
  });

  it("save 保留未传字段的旧 DB 值", async () => {
    mockedGet.mockResolvedValue({ maxUploadSizeMb: 200, paymentProofMaxSizeMb: 5 });
    const { saveUploadConfig } = await import("./upload");
    await saveUploadConfig({ maxUploadSizeMb: 300 });
    expect(mockedSet).toHaveBeenCalledWith("upload", {
      maxUploadSizeMb: 300,
      paymentProofMaxSizeMb: 5,
    });
  });

  it("save 删除两者均缺失时不写入 undefined", async () => {
    mockedGet.mockResolvedValue(null);
    const { saveUploadConfig } = await import("./upload");
    await saveUploadConfig({});
    expect(mockedSet).toHaveBeenCalledWith("upload", {});
  });

  it("清除配置组后回落环境变量", async () => {
    const { clearUploadConfig } = await import("./upload");
    await clearUploadConfig();
    expect(mockedDelete).toHaveBeenCalledWith("upload");
  });
});
