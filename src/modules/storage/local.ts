import { randomUUID } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import type { Readable } from "stream";
import { pipeline } from "stream/promises";

import {
  compensateAndPreserveError,
  opaqueCompensationResourceId,
  summarizeErrorForLog,
} from "@/lib/compensation";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

import { createMeasuredStream } from "./stream";
import type {
  DeleteObjectInput,
  GetObjectInput,
  PutObjectInput,
  PutObjectStreamInput,
  StorageAdapter,
  StoredObject,
} from "./types";

const PART_SUFFIX = ".part";
const PART_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PART_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let lastPartCleanupAttemptAt = 0;
let partCleanupPromise: Promise<void> | null = null;

export function resetLocalUploadPartCleanupStateForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Local upload cleanup state can only be reset in tests");
  }
  lastPartCleanupAttemptAt = 0;
  partCleanupPromise = null;
}

function uploadRoot(): string {
  return path.resolve(getEnv().UPLOAD_DIR);
}

function resolveSafePath(objectKey: string): string {
  const root = uploadRoot();
  const full = path.resolve(root, objectKey);
  if (!full.startsWith(root + path.sep)) {
    throw new Error("非法文件路径");
  }
  return full;
}

async function removeStaleParts(directory: string, cutoff: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await removeStaleParts(full, cutoff);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(PART_SUFFIX)) return;
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await unlink(full).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        });
      }
    }),
  );
}

export async function cleanupStaleLocalUploadParts(now = Date.now()): Promise<void> {
  await removeStaleParts(uploadRoot(), now - PART_MAX_AGE_MS);
}

async function maybeCleanupStaleParts(): Promise<void> {
  const now = Date.now();
  if (now - lastPartCleanupAttemptAt < PART_CLEANUP_INTERVAL_MS) return;
  if (!partCleanupPromise) {
    lastPartCleanupAttemptAt = now;
    partCleanupPromise = cleanupStaleLocalUploadParts(now).finally(() => {
      partCleanupPromise = null;
    });
  }
  try {
    await partCleanupPromise;
  } catch (cleanupError) {
    try {
      logger.warn("Stale local upload part cleanup failed", {
        operation: "local_upload_part.cleanup_stale",
        cleanupError: summarizeErrorForLog(cleanupError),
      });
    } catch {
      // Opportunistic cleanup and its observability must not block a valid upload.
    }
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  driver = "local" as const;

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const full = resolveSafePath(input.objectKey);
    const temporary = `${full}.${randomUUID()}${PART_SUFFIX}`;
    await mkdir(path.dirname(full), { recursive: true });
    await maybeCleanupStaleParts();
    try {
      await writeFile(temporary, input.body, { flag: "wx" });
      await rename(temporary, full);
      return { objectKey: input.objectKey, bucket: null };
    } catch (error) {
      throw await compensateAndPreserveError(
        error,
        [
          {
            operation: "local_upload_part.unlink",
            run: async () => {
              await unlink(temporary).catch((cleanupError) => {
                if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
              });
            },
          },
        ],
        { objectRef: opaqueCompensationResourceId(this.driver, input.objectKey) },
      );
    }
  }

  async putObjectStream(input: PutObjectStreamInput): Promise<{
    stored: StoredObject;
    sizeBytes: number;
    sha256: string;
  }> {
    const full = resolveSafePath(input.objectKey);
    const temporary = `${full}.${randomUUID()}${PART_SUFFIX}`;
    await mkdir(path.dirname(full), { recursive: true });
    await maybeCleanupStaleParts();

    const measured = createMeasuredStream(input.maxBytes);
    try {
      await pipeline(input.body, measured.stream, createWriteStream(temporary, { flags: "wx" }), {
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      const result = measured.result();
      await rename(temporary, full);
      return {
        stored: { objectKey: input.objectKey, bucket: null },
        ...result,
      };
    } catch (err) {
      throw await compensateAndPreserveError(
        err,
        [
          {
            operation: "local_upload_part.unlink",
            run: async () => {
              await unlink(temporary).catch((cleanupError) => {
                if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
              });
            },
          },
        ],
        { objectRef: opaqueCompensationResourceId(this.driver, input.objectKey) },
      );
    }
  }

  async getObject(input: GetObjectInput): Promise<Readable> {
    const full = resolveSafePath(input.objectKey);
    return createReadStream(full, { start: input.start, end: input.end });
  }

  async deleteObject(input: DeleteObjectInput): Promise<void> {
    const full = resolveSafePath(input.objectKey);
    await unlink(full).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
}
