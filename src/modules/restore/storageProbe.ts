import { readdir } from "node:fs/promises";
import path from "node:path";

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "stream";

import { getEnv } from "@/lib/env";
import type { ResolvedStorageConfig } from "@/modules/config/storageResolve";
import { getStorageForDriver, type StorageDriver } from "@/modules/storage/runtime";

import { parseS3EnumerationPrefixes, validateS3EnumerationPrefix } from "./s3EnumerationPrefixes";

export const DEFAULT_ENUMERATION_PAGE_SIZE = 1_000;
export const DEFAULT_MAX_ENUMERATED_OBJECTS = 100_000;

export function normalizeStorageBucket(input: {
  driver: StorageDriver;
  bucket: string | null;
  storageConfig: ResolvedStorageConfig;
}): string | null {
  if (input.driver === "local") return null;
  return input.bucket ?? input.storageConfig.bucket ?? null;
}

export function storageObjectIdentity(
  driver: StorageDriver,
  bucket: string | null,
  objectKey: string,
  storageConfig?: ResolvedStorageConfig,
): string {
  const normalizedBucket =
    storageConfig !== undefined
      ? normalizeStorageBucket({ driver, bucket, storageConfig })
      : bucket;
  return `${driver}\0${normalizedBucket ?? ""}\0${objectKey}`;
}

function localUploadRoot(): string {
  return path.resolve(getEnv().UPLOAD_DIR);
}

function createS3Client(config: ResolvedStorageConfig): S3Client {
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("S3 storage configuration is incomplete");
  }
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

async function readableExists(stream: Readable): Promise<boolean> {
  return new Promise((resolve, reject) => {
    stream.once("readable", () => {
      stream.destroy();
      resolve(true);
    });
    stream.once("error", (error) => {
      stream.destroy();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        resolve(false);
        return;
      }
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404 || status === 410) {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

export async function objectExists(input: {
  driver: StorageDriver;
  bucket: string | null;
  objectKey: string;
}): Promise<boolean> {
  const storage = await getStorageForDriver(input.driver);
  try {
    const stream = await storage.getObject({
      objectKey: input.objectKey,
      bucket: input.bucket,
      start: 0,
      end: 0,
    });
    return readableExists(stream);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || status === 410) return false;
    throw error;
  }
}

async function enumerateLocalObjects(input: {
  root?: string;
  pageSize: number;
  maxObjects: number;
}): Promise<{ objectKeys: string[]; truncated: boolean }> {
  const root = input.root ?? localUploadRoot();
  const objectKeys: string[] = [];
  let truncated = false;

  async function walk(relativeDir: string): Promise<void> {
    if (objectKeys.length >= input.maxObjects) {
      truncated = true;
      return;
    }

    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (objectKeys.length >= input.maxObjects) {
        truncated = true;
        return;
      }

      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".part")) continue;
      objectKeys.push(relativePath.split(path.sep).join("/"));
      if (objectKeys.length >= input.maxObjects) {
        truncated = true;
        return;
      }
    }
  }

  await walk("");
  return { objectKeys, truncated };
}

async function enumerateS3Objects(input: {
  storageConfig: ResolvedStorageConfig;
  prefix: string;
  pageSize: number;
  maxObjects: number;
}): Promise<{ objectKeys: string[]; bucket: string; truncated: boolean }> {
  const bucket = input.storageConfig.bucket;
  if (!bucket) throw new Error("S3 enumeration requires a configured bucket");

  const prefix = input.prefix.trim();
  validateS3EnumerationPrefix(prefix);

  const client = createS3Client(input.storageConfig);
  const objectKeys: string[] = [];
  let continuationToken: string | undefined;
  let truncated = false;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: Math.min(input.pageSize, input.maxObjects - objectKeys.length),
      }),
    );

    for (const entry of response.Contents ?? []) {
      if (!entry.Key || entry.Key.endsWith("/")) continue;
      objectKeys.push(entry.Key);
      if (objectKeys.length >= input.maxObjects) {
        truncated = true;
        break;
      }
    }

    if (truncated) break;
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    if (response.IsTruncated && !continuationToken) truncated = true;
  } while (continuationToken);

  return { objectKeys, bucket, truncated };
}

export async function enumerateS3ObjectsUnderPrefixes(input: {
  storageConfig: ResolvedStorageConfig;
  prefixes?: string | readonly string[];
  pageSize: number;
  maxObjects: number;
}): Promise<{ objectKeys: string[]; bucket: string; truncated: boolean }> {
  const prefixes = parseS3EnumerationPrefixes(input.prefixes);
  const objectKeys: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let bucket = "";

  for (const prefix of prefixes) {
    if (objectKeys.length >= input.maxObjects) {
      truncated = true;
      break;
    }

    const remaining = input.maxObjects - objectKeys.length;
    const result = await enumerateS3Objects({
      storageConfig: input.storageConfig,
      prefix,
      pageSize: input.pageSize,
      maxObjects: remaining,
    });
    bucket = result.bucket;

    for (const objectKey of result.objectKeys) {
      if (seen.has(objectKey)) continue;
      seen.add(objectKey);
      objectKeys.push(objectKey);
      if (objectKeys.length >= input.maxObjects) {
        truncated = true;
        break;
      }
    }

    if (result.truncated || truncated) {
      truncated = true;
      break;
    }
  }

  if (!bucket) {
    throw new Error("S3 enumeration requires a configured bucket");
  }

  return { objectKeys, bucket, truncated };
}

export async function enumerateStorageObjects(input: {
  driver: StorageDriver;
  storageConfig: ResolvedStorageConfig;
  pageSize?: number;
  maxObjects?: number;
  prefix?: string;
  prefixes?: string | readonly string[];
}): Promise<{ objectKeys: string[]; bucket: string | null; truncated: boolean }> {
  const pageSize = input.pageSize ?? DEFAULT_ENUMERATION_PAGE_SIZE;
  const maxObjects = input.maxObjects ?? DEFAULT_MAX_ENUMERATED_OBJECTS;

  if (input.driver === "local") {
    const result = await enumerateLocalObjects({ pageSize, maxObjects });
    return { ...result, bucket: null };
  }

  const prefixes = input.prefixes ?? input.prefix;
  if (typeof prefixes === "string" && prefixes.includes(",")) {
    return enumerateS3ObjectsUnderPrefixes({
      storageConfig: input.storageConfig,
      prefixes,
      pageSize,
      maxObjects,
    });
  }

  if (Array.isArray(prefixes) && prefixes.length > 1) {
    return enumerateS3ObjectsUnderPrefixes({
      storageConfig: input.storageConfig,
      prefixes,
      pageSize,
      maxObjects,
    });
  }

  const singlePrefix =
    typeof prefixes === "string" ? prefixes : Array.isArray(prefixes) ? prefixes[0] : undefined;
  if (!singlePrefix?.trim()) {
    return enumerateS3ObjectsUnderPrefixes({
      storageConfig: input.storageConfig,
      pageSize,
      maxObjects,
    });
  }

  return enumerateS3Objects({
    storageConfig: input.storageConfig,
    prefix: singlePrefix,
    pageSize,
    maxObjects,
  });
}
