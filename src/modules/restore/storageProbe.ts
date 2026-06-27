import { readdir } from "node:fs/promises";
import path from "node:path";

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "stream";

import { getEnv } from "@/lib/env";
import type { ResolvedStorageConfig } from "@/modules/config/storageResolve";
import { getStorageForDriver, type StorageDriver } from "@/modules/storage/runtime";

export const DEFAULT_ENUMERATION_PAGE_SIZE = 1_000;
export const DEFAULT_MAX_ENUMERATED_OBJECTS = 100_000;

export function storageObjectIdentity(
  driver: StorageDriver,
  bucket: string | null,
  objectKey: string,
): string {
  return `${driver}\0${bucket ?? ""}\0${objectKey}`;
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
  prefix?: string;
  pageSize: number;
  maxObjects: number;
}): Promise<{ objectKeys: string[]; bucket: string; truncated: boolean }> {
  const bucket = input.storageConfig.bucket;
  if (!bucket) throw new Error("S3 enumeration requires a configured bucket");

  const prefix = input.prefix?.trim();
  if (!prefix) {
    throw new Error("S3 enumeration requires an explicit prefix");
  }

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

export async function enumerateStorageObjects(input: {
  driver: StorageDriver;
  storageConfig: ResolvedStorageConfig;
  pageSize?: number;
  maxObjects?: number;
  prefix?: string;
}): Promise<{ objectKeys: string[]; bucket: string | null; truncated: boolean }> {
  const pageSize = input.pageSize ?? DEFAULT_ENUMERATION_PAGE_SIZE;
  const maxObjects = input.maxObjects ?? DEFAULT_MAX_ENUMERATED_OBJECTS;

  if (input.driver === "local") {
    const result = await enumerateLocalObjects({ pageSize, maxObjects });
    return { ...result, bucket: null };
  }

  const result = await enumerateS3Objects({
    storageConfig: input.storageConfig,
    prefix: input.prefix,
    pageSize,
    maxObjects,
  });
  return result;
}
