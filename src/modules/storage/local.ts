import { createReadStream } from "fs";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import type { Readable } from "stream";

import { getEnv } from "@/lib/env";

import type {
  DeleteObjectInput,
  GetObjectInput,
  PutObjectInput,
  StorageAdapter,
  StoredObject,
} from "./types";

function resolveSafePath(objectKey: string): string {
  const root = path.resolve(getEnv().UPLOAD_DIR);
  const full = path.resolve(root, objectKey);
  if (!full.startsWith(root + path.sep)) {
    throw new Error("非法文件路径");
  }
  return full;
}

export class LocalStorageAdapter implements StorageAdapter {
  driver = "local" as const;

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const full = resolveSafePath(input.objectKey);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, input.body);
    return { objectKey: input.objectKey, bucket: null };
  }

  async getObject(input: GetObjectInput): Promise<Readable> {
    const full = resolveSafePath(input.objectKey);
    return createReadStream(full);
  }

  async deleteObject(input: DeleteObjectInput): Promise<void> {
    const full = resolveSafePath(input.objectKey);
    await unlink(full).catch((err) => {
      if (err?.code !== "ENOENT") throw err;
    });
  }
}
