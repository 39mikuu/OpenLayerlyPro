import { ApiError } from "@/lib/api";
import { getStorageConfig, type ResolvedStorageConfig } from "@/modules/config";

import { LocalStorageAdapter } from "./local";
import { S3StorageAdapter } from "./s3";
import type { StorageAdapter } from "./types";

export type StorageDriver = "local" | "s3";

function createS3Storage(config: ResolvedStorageConfig): S3StorageAdapter {
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("STORAGE_DRIVER=s3 但 S3 配置不完整");
  }
  return new S3StorageAdapter({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
  });
}

function createStorage(driver: StorageDriver, config: ResolvedStorageConfig): StorageAdapter {
  return driver === "s3" ? createS3Storage(config) : new LocalStorageAdapter();
}

/** 不缓存 adapter，确保后台修改 endpoint 或凭据后下一次操作立即使用新配置。 */
export async function getStorage(): Promise<StorageAdapter> {
  const config = await getStorageConfig();
  return createStorage(config.driver, config);
}

export async function getStorageForDriver(driver: StorageDriver): Promise<StorageAdapter> {
  return createStorage(driver, await getStorageConfig());
}

export async function testS3Connection(): Promise<void> {
  const config = await getStorageConfig();
  if (!config.s3Configured) {
    throw new ApiError(400, "s3ConfigIncomplete");
  }
  try {
    await createS3Storage(config).testConnection();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "未知错误";
    throw new ApiError(400, "s3TestFailed", { detail });
  }
}

export type { StorageAdapter } from "./types";
