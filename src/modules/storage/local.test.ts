import { createHash } from "crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  mocks.readdir.mockImplementation(actual.readdir);
  return { ...actual, readdir: mocks.readdir };
});

vi.mock("@/lib/logger", () => ({
  logger: { error: mocks.loggerError, info: vi.fn(), warn: mocks.loggerWarn },
}));

import {
  cleanupStaleLocalUploadParts,
  LocalStorageAdapter,
  resetLocalUploadPartCleanupStateForTests,
} from "./local";
import { StorageObjectTooLargeError } from "./stream";

let uploadDir = "";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ UPLOAD_DIR: uploadDir }),
}));

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

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
    resetLocalUploadPartCleanupStateForTests();
    mocks.loggerError.mockReset();
    mocks.loggerWarn.mockReset();
    mocks.readdir.mockClear();
    uploadDir = await mkdtemp(path.join(tmpdir(), "openlayerly-local-upload-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(uploadDir, { recursive: true, force: true });
  });

  it("cleans stale parts before publishing a buffered object", async () => {
    const directory = path.join(uploadDir, "content");
    const stalePart = path.join(directory, "crashed.part");
    await import("fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(stalePart, "orphan");
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(stalePart, stale, stale);

    const adapter = new LocalStorageAdapter();
    const result = await adapter.putObject({
      objectKey: "content/new.png",
      body: Buffer.from("new image"),
      contentType: "image/png",
    });

    await expect(stat(stalePart)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(uploadDir, result.objectKey))).resolves.toEqual(
      Buffer.from("new image"),
    );
  });

  it("publishes a buffered object when opportunistic stale-part cleanup fails", async () => {
    const cleanupError = Object.assign(new Error(`cannot scan ${uploadDir}`), { code: "EACCES" });
    mocks.readdir.mockRejectedValueOnce(cleanupError);

    const adapter = new LocalStorageAdapter();
    const body = Buffer.from("new payment proof");
    const result = await adapter.putObject({
      objectKey: "payment-proof/cleanup-failed.png",
      body,
      contentType: "image/png",
    });

    expect(await readFile(path.join(uploadDir, result.objectKey))).toEqual(body);
    expect(mocks.readdir).toHaveBeenCalledOnce();
    await adapter.putObject({
      objectKey: "payment-proof/cleanup-throttled.png",
      body,
      contentType: "image/png",
    });
    expect(mocks.readdir).toHaveBeenCalledOnce();
    expect(mocks.loggerWarn).toHaveBeenCalledWith("Stale local upload part cleanup failed", {
      operation: "local_upload_part.cleanup_stale",
      cleanupError: { name: "Error", identifier: "EACCES" },
    });
    const logged = JSON.stringify(mocks.loggerWarn.mock.calls);
    expect(logged).not.toContain(uploadDir);
    expect(logged).not.toContain(cleanupError.message);
    expect((await listFiles(uploadDir)).some((file) => file.endsWith(".part"))).toBe(false);
  });

  it("publishes a buffered object when stale-part failure logging also fails", async () => {
    mocks.readdir.mockRejectedValueOnce(Object.assign(new Error("scan failed"), { code: "EIO" }));
    mocks.loggerWarn.mockImplementationOnce(() => {
      throw new Error("logger failed");
    });

    const adapter = new LocalStorageAdapter();
    const body = Buffer.from("new cover image");
    const result = await adapter.putObject({
      objectKey: "content/cleanup-log-failed.png",
      body,
      contentType: "image/png",
    });

    expect(await readFile(path.join(uploadDir, result.objectKey))).toEqual(body);
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
  });

  it("publishes a streamed object when opportunistic stale-part cleanup fails", async () => {
    mocks.readdir.mockRejectedValueOnce(Object.assign(new Error("scan failed"), { code: "EIO" }));

    const adapter = new LocalStorageAdapter();
    const body = Buffer.from("streamed after cleanup failure");
    const result = await adapter.putObjectStream({
      objectKey: "content/cleanup-failed.bin",
      body: Readable.from([body]),
      contentType: "application/octet-stream",
      maxBytes: 1024,
    });

    expect(result.stored.objectKey).toBe("content/cleanup-failed.bin");
    expect(await readFile(path.join(uploadDir, result.stored.objectKey))).toEqual(body);
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent cleanup attempts without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    let rejectCleanup!: (error: unknown) => void;
    const blockedCleanup = new Promise<never>((_resolve, reject) => {
      rejectCleanup = reject;
    });
    mocks.readdir.mockReturnValueOnce(blockedCleanup);

    try {
      const adapter = new LocalStorageAdapter();
      const buffered = adapter.putObject({
        objectKey: "payment-proof/concurrent.png",
        body: Buffer.from("buffered"),
        contentType: "image/png",
      });
      const streamed = adapter.putObjectStream({
        objectKey: "content/concurrent.bin",
        body: Readable.from([Buffer.from("streamed")]),
        contentType: "application/octet-stream",
        maxBytes: 1024,
      });
      await vi.waitFor(() => expect(mocks.readdir).toHaveBeenCalledOnce());
      rejectCleanup(Object.assign(new Error(`cannot scan ${uploadDir}`), { code: "EACCES" }));

      await expect(buffered).resolves.toMatchObject({ objectKey: "payment-proof/concurrent.png" });
      await expect(streamed).resolves.toMatchObject({
        stored: { objectKey: "content/concurrent.bin" },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(mocks.loggerWarn).toHaveBeenCalledOnce();
      await expect(readFile(path.join(uploadDir, "payment-proof/concurrent.png"))).resolves.toEqual(
        Buffer.from("buffered"),
      );
      await expect(readFile(path.join(uploadDir, "content/concurrent.bin"))).resolves.toEqual(
        Buffer.from("streamed"),
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps explicit stale-part cleanup failures strict", async () => {
    const cleanupError = Object.assign(new Error(`cannot scan ${uploadDir}`), { code: "EACCES" });
    mocks.readdir.mockRejectedValueOnce(cleanupError);

    await expect(cleanupStaleLocalUploadParts()).rejects.toBe(cleanupError);
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
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

  it("atomically publishes buffered objects without leaving a part file", async () => {
    const adapter = new LocalStorageAdapter();
    const body = Buffer.from("buffered image");

    const result = await adapter.putObject({
      objectKey: "payment-proof/proof.png",
      body,
      contentType: "image/png",
    });

    expect(await readFile(path.join(uploadDir, result.objectKey))).toEqual(body);
    expect((await listFiles(uploadDir)).some((file) => file.endsWith(".part"))).toBe(false);
  });

  it("preserves a buffered publish failure and removes its temporary object", async () => {
    const adapter = new LocalStorageAdapter();
    const destination = path.join(uploadDir, "payment-proof", "occupied.png");
    await import("fs/promises").then(({ mkdir }) => mkdir(destination, { recursive: true }));

    let thrown: unknown;
    try {
      await adapter.putObject({
        objectKey: "payment-proof/occupied.png",
        body: Buffer.from("buffered image"),
        contentType: "image/png",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: expect.stringMatching(/EISDIR|ENOTEMPTY/) });
    expect((await listFiles(uploadDir)).some((file) => file.endsWith(".part"))).toBe(false);
  });

  it("makes repeated object deletion idempotent", async () => {
    const adapter = new LocalStorageAdapter();
    await adapter.putObject({
      objectKey: "content/retry.txt",
      body: Buffer.from("retry"),
      contentType: "text/plain",
    });

    await expect(adapter.deleteObject({ objectKey: "content/retry.txt" })).resolves.toBeUndefined();
    await expect(adapter.deleteObject({ objectKey: "content/retry.txt" })).resolves.toBeUndefined();
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

  it("reads full objects and exact inclusive byte ranges", async () => {
    const adapter = new LocalStorageAdapter();
    const body = Buffer.from("0123456789abcdef");
    await adapter.putObject({
      objectKey: "content/range.bin",
      body,
      contentType: "application/octet-stream",
    });

    await expect(
      streamToBuffer(await adapter.getObject({ objectKey: "content/range.bin" })),
    ).resolves.toEqual(body);
    await expect(
      streamToBuffer(await adapter.getObject({ objectKey: "content/range.bin", start: 3, end: 7 })),
    ).resolves.toEqual(Buffer.from("34567"));
    await expect(
      streamToBuffer(await adapter.getObject({ objectKey: "content/range.bin", start: 10 })),
    ).resolves.toEqual(Buffer.from("abcdef"));
  });

  it("keeps Range reads behind resolveSafePath", async () => {
    const adapter = new LocalStorageAdapter();
    await expect(
      adapter.getObject({ objectKey: "../outside.mp4", start: 0, end: 1 }),
    ).rejects.toThrow("非法文件路径");
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
