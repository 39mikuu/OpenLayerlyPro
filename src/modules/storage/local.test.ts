import { createHash } from "crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupStaleLocalUploadParts, LocalStorageAdapter } from "./local";
import { StorageObjectTooLargeError } from "./stream";

let uploadDir = "";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ UPLOAD_DIR: uploadDir }),
}));

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    }),
  );
  return nested.flat();
}

describe("LocalStorageAdapter streaming uploads", () => {
  beforeEach(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), "openlayerly-local-upload-"));
  });

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  it("writes through a same-directory part file and atomically publishes the final object", async () => {
    const adapter = new LocalStorageAdapter();
    const body = Buffer.from("streamed attachment");

    const result = await adapter.putObjectStream({
      objectKey: "content/2026/06/example.mp4",
      body: Readable.from([body.subarray(0, 7), body.subarray(7)]),
      contentType: "video/mp4",
      maxBytes: 1024,
    });

    expect(result.sizeBytes).toBe(body.length);
    expect(result.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await readFile(path.join(uploadDir, result.stored.objectKey))).toEqual(body);
    expect((await listFiles(uploadDir)).some((file) => file.endsWith(".part"))).toBe(false);
  });

  it("removes temporary and final files when the measured stream exceeds the limit", async () => {
    const adapter = new LocalStorageAdapter();
    let produced = 0;
    async function* chunks() {
      for (let i = 0; i < 100; i += 1) {
        produced += 1;
        yield Buffer.alloc(16);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    await expect(
      adapter.putObjectStream({
        objectKey: "content/2026/06/too-large.zip",
        body: Readable.from(chunks()),
        contentType: "application/zip",
        maxBytes: 31,
      }),
    ).rejects.toBeInstanceOf(StorageObjectTooLargeError);

    expect(produced).toBeLessThan(100);
    expect(await listFiles(uploadDir)).toEqual([]);
  });

  it("removes the part file when the request is aborted", async () => {
    const adapter = new LocalStorageAdapter();
    const controller = new AbortController();
    async function* chunks() {
      while (true) {
        yield Buffer.alloc(1024);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const upload = adapter.putObjectStream({
      objectKey: "content/2026/06/aborted.webm",
      body: Readable.from(chunks()),
      contentType: "video/webm",
      maxBytes: 1024 * 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 15);

    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(await listFiles(uploadDir)).toEqual([]);
  });

  it("cleans stale part files left by a crashed process", async () => {
    const directory = path.join(uploadDir, "content", "2026", "06");
    const part = path.join(directory, "orphan.part");
    await import("fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(part, "orphan");
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(part, stale, stale);

    await cleanupStaleLocalUploadParts();

    await expect(stat(part)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
