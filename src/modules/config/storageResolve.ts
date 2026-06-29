import { z } from "zod";

import { getEnv } from "@/lib/env";

import { getStoredGroup } from "./store";

export const STORAGE_GROUP = "storage";

export const storageConfigSchema = z.object({
  driver: z.enum(["local", "s3"]).optional(),
  endpoint: z.string().optional(),
  region: z.string().optional(),
  bucket: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
});
export type StorageConfigInput = z.infer<typeof storageConfigSchema>;

export type ResolvedStorageConfig = {
  driver: "local" | "s3";
  endpoint?: string;
  region: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  s3Configured: boolean;
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveStorageConfig(stored: StorageConfigInput): ResolvedStorageConfig {
  const env = getEnv();
  const endpoint = nonEmpty(stored.endpoint) ?? nonEmpty(env.S3_ENDPOINT);
  const region = nonEmpty(stored.region) ?? nonEmpty(env.S3_REGION) ?? "auto";
  const bucket = nonEmpty(stored.bucket) ?? nonEmpty(env.S3_BUCKET);
  const accessKeyId = nonEmpty(stored.accessKeyId) ?? nonEmpty(env.S3_ACCESS_KEY_ID);
  const secretAccessKey = nonEmpty(stored.secretAccessKey) ?? nonEmpty(env.S3_SECRET_ACCESS_KEY);

  return {
    driver: stored.driver ?? env.STORAGE_DRIVER,
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: stored.forcePathStyle ?? env.S3_FORCE_PATH_STYLE,
    s3Configured: Boolean(endpoint && bucket && accessKeyId && secretAccessKey),
  };
}

/** 解析最终生效的存储配置，优先级为 DB ＞ 环境变量 ＞ 默认值。 */
export async function getStorageConfig(): Promise<ResolvedStorageConfig> {
  const stored = (await getStoredGroup<StorageConfigInput>(STORAGE_GROUP)) ?? {};
  return resolveStorageConfig(stored);
}
