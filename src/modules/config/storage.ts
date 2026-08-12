import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";

import { requireExpectedRevision } from "./revision";
import {
  getStorageConfig,
  type ResolvedStorageConfig,
  resolveStorageConfig,
  STORAGE_GROUP,
  type StorageConfigInput,
  storageConfigSchema,
} from "./storageResolve";
import { deleteStoredGroup, getStoredGroupSnapshot, setStoredGroup } from "./store";

export {
  getStorageConfig,
  type ResolvedStorageConfig,
  resolveStorageConfig,
  STORAGE_GROUP,
  type StorageConfigInput,
  storageConfigSchema,
};

export type StorageAdminView = {
  revision: number;
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

export async function getStorageAdminView(): Promise<StorageAdminView> {
  const env = getEnv();
  const snapshot = await getStoredGroupSnapshot<StorageConfigInput>(STORAGE_GROUP);
  const stored = snapshot.value;
  const effective = resolveStorageConfig(stored ?? {});

  return {
    revision: snapshot.revision,
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

export async function saveStorageConfig(
  input: StorageConfigInput,
  expectedRevision = 0,
): Promise<number> {
  const snapshot = await getStoredGroupSnapshot<StorageConfigInput>(STORAGE_GROUP);
  requireExpectedRevision(snapshot.revision, expectedRevision);
  const existing = snapshot.value ?? {};
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

  return setStoredGroup<StorageConfigInput>(STORAGE_GROUP, next, expectedRevision);
}

export async function clearStorageConfig(expectedRevision = 0): Promise<number> {
  return deleteStoredGroup(STORAGE_GROUP, expectedRevision);
}
