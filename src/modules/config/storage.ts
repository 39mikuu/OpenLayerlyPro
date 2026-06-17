import { z } from "zod";

import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";

import { deleteStoredGroup, getStoredGroup, setStoredGroup } from "./store";

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

export type StorageAdminView = {
  driver: "local" | "s3";
  endpoint?: string;
  region: string;
  bucket?: string;
  forcePathStyle: boolean;
  s3Configured: boolean;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  hasDbOverride: boolean;
  envDefaults: {
    driver: "local" | "s3";
    endpoint?: string;
    region: string;
    bucket?: string;
    forcePathStyle: boolean;
    accessKeyIdSet: boolean;
    secretAccessKeySet: boolean;
  };
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveStorageConfig(stored: StorageConfigInput): ResolvedStorageConfig {
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

export async function getStorageAdminView(): Promise<StorageAdminView> {
  const env = getEnv();
  const [effective, stored] = await Promise.all([
    getStorageConfig(),
    getStoredGroup<StorageConfigInput>(STORAGE_GROUP),
  ]);

  return {
    driver: effective.driver,
    endpoint: effective.endpoint,
    region: effective.region,
    bucket: effective.bucket,
    forcePathStyle: effective.forcePathStyle,
    s3Configured: effective.s3Configured,
    accessKeyIdSet: Boolean(effective.accessKeyId),
    secretAccessKeySet: Boolean(effective.secretAccessKey),
    hasDbOverride: stored !== null,
    envDefaults: {
      driver: env.STORAGE_DRIVER,
      endpoint: nonEmpty(env.S3_ENDPOINT),
      region: nonEmpty(env.S3_REGION) ?? "auto",
      bucket: nonEmpty(env.S3_BUCKET),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      accessKeyIdSet: Boolean(nonEmpty(env.S3_ACCESS_KEY_ID)),
      secretAccessKeySet: Boolean(nonEmpty(env.S3_SECRET_ACCESS_KEY)),
    },
  };
}

function preserveOrTrimmed(
  input: string | undefined,
  existing: string | undefined,
): string | undefined {
  return input === undefined ? nonEmpty(existing) : nonEmpty(input);
}

function preserveSensitive(
  input: string | undefined,
  existing: string | undefined,
): string | undefined {
  return nonEmpty(input) ?? nonEmpty(existing);
}

export async function saveStorageConfig(input: StorageConfigInput): Promise<void> {
  const existing = (await getStoredGroup<StorageConfigInput>(STORAGE_GROUP)) ?? {};
  const next: StorageConfigInput = {};

  next.driver = input.driver ?? existing.driver;
  next.endpoint = preserveOrTrimmed(input.endpoint, existing.endpoint);
  next.region = preserveOrTrimmed(input.region, existing.region);
  next.bucket = preserveOrTrimmed(input.bucket, existing.bucket);
  next.accessKeyId = preserveSensitive(input.accessKeyId, existing.accessKeyId);
  next.secretAccessKey = preserveSensitive(input.secretAccessKey, existing.secretAccessKey);
  next.forcePathStyle = input.forcePathStyle ?? existing.forcePathStyle;

  for (const key of Object.keys(next) as (keyof StorageConfigInput)[]) {
    if (next[key] === undefined) delete next[key];
  }

  const effective = resolveStorageConfig(next);
  if (effective.driver === "s3" && !effective.s3Configured) {
    throw new ApiError(400, "storageConfigIncomplete");
  }

  await setStoredGroup<StorageConfigInput>(STORAGE_GROUP, next);
}

export async function clearStorageConfig(): Promise<void> {
  await deleteStoredGroup(STORAGE_GROUP);
}
