import { ApiError } from "@/lib/api";
import { getStorageConfig } from "@/modules/config/storageResolve";

import { S3StorageAdapter } from "./s3";

export { getStorage, getStorageForDriver, type StorageDriver } from "./runtime";

export async function testS3Connection(): Promise<void> {
  const config = await getStorageConfig();
  if (!config.s3Configured) {
    throw new ApiError(400, "s3ConfigIncomplete");
  }
  try {
    if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new Error("STORAGE_DRIVER=s3 但 S3 配置不完整");
    }
    await new S3StorageAdapter({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
    }).testConnection();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "未知错误";
    throw new ApiError(400, "s3TestFailed", { detail });
  }
}

export type { StorageAdapter } from "./types";
