import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStorageConfig } from "@/modules/config/storageResolve";

vi.mock("@/modules/config/storageResolve", () => ({
  getStorageConfig: vi.fn(),
}));

const mockedGetStorageConfig = vi.mocked(getStorageConfig);

describe("storage adapter lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockedGetStorageConfig.mockResolvedValue({
      driver: "s3",
      endpoint: "https://s3.example.com",
      region: "auto",
      bucket: "test-bucket",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      forcePathStyle: true,
      s3Configured: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("不按 driver 永久缓存 S3 adapter", async () => {
    const { getStorage } = await import("./index");
    const first = await getStorage();
    const second = await getStorage();

    expect(first).not.toBe(second);
    expect(mockedGetStorageConfig).toHaveBeenCalledTimes(2);
  });
});
