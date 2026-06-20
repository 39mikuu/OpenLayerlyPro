import { Readable } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  enqueueTask: vi.fn(),
  getDb: vi.fn(),
  getStorage: vi.fn(),
  insert: vi.fn(),
  putObject: vi.fn(),
  putObjectStream: vi.fn(),
  recordEvent: vi.fn(),
  returning: vi.fn(),
  values: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ INLINE_UPLOAD_GRACE_PERIOD_HOURS: 24 }),
}));
vi.mock("@/modules/config", () => ({
  getUploadConfig: vi.fn(async () => ({
    maxUploadSizeMb: 10,
    paymentProofMaxSizeMb: 10,
  })),
}));
vi.mock("@/modules/site", () => ({ getSetting: vi.fn() }));
vi.mock("@/modules/storage", () => ({
  getStorage: mocks.getStorage,
  getStorageForDriver: vi.fn(),
}));
vi.mock("@/modules/system/events", () => ({ recordEvent: mocks.recordEvent }));
vi.mock("@/modules/tasks", () => ({ enqueueTask: mocks.enqueueTask }));

import { ApiError } from "@/lib/api";

import { parseStreamFileName, saveStreamedFile, saveUploadedFile } from "./index";

const storage = {
  driver: "local" as const,
  deleteObject: mocks.deleteObject,
  getObject: vi.fn(),
  putObject: mocks.putObject,
  putObjectStream: mocks.putObjectStream,
};

function setInsertResult(result: unknown) {
  mocks.returning.mockResolvedValue(result);
  mocks.values.mockReturnValue({ returning: mocks.returning });
  mocks.insert.mockReturnValue({ values: mocks.values });
  const tx = { insert: mocks.insert };
  mocks.getDb.mockReturnValue({
    insert: mocks.insert,
    transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
  });
}

describe("streamed file persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStorage.mockResolvedValue(storage);
    mocks.putObjectStream.mockResolvedValue({
      stored: { objectKey: "content/2026/06/video.mp4", bucket: null },
      sizeBytes: 123,
      sha256: "a".repeat(64),
    });
    mocks.deleteObject.mockResolvedValue(undefined);
    mocks.putObject.mockResolvedValue({ objectKey: "content/image.png", bucket: null });
    setInsertResult([{ id: "file-1" }]);
  });

  it.each([
    ["movie.mp4", "video/mp4"],
    ["movie.webm", "video/webm"],
    ["movie.mov", "video/quicktime"],
    ["movie.m4v", "video/x-m4v"],
  ])("accepts %s and stores the canonical MIME type", async (fileName, mimeType) => {
    await saveStreamedFile({
      body: Readable.from([Buffer.from("video")]),
      fileName,
      purpose: "content_attachment",
      createdBy: "admin-1",
    });

    expect(mocks.putObjectStream).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: mimeType, maxBytes: 10 * 1024 * 1024 }),
    );
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: fileName,
        mimeType,
        purpose: "content_attachment",
        sizeBytes: 123,
      }),
    );
  });

  it("deletes the uploaded object when the database insert fails", async () => {
    mocks.returning.mockRejectedValue(new Error("database unavailable"));

    await expect(
      saveStreamedFile({
        body: Readable.from([Buffer.from("attachment")]),
        fileName: "archive.zip",
        purpose: "content_attachment",
      }),
    ).rejects.toThrow("database unavailable");

    expect(mocks.deleteObject).toHaveBeenCalledWith({
      objectKey: "content/2026/06/video.mp4",
      bucket: null,
    });
  });

  it("deletes an empty uploaded object before returning fileEmpty", async () => {
    mocks.putObjectStream.mockResolvedValue({
      stored: { objectKey: "content/empty.txt", bucket: null },
      sizeBytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });

    await expect(
      saveStreamedFile({
        body: Readable.from([]),
        fileName: "empty.txt",
        purpose: "content_attachment",
      }),
    ).rejects.toMatchObject({ code: "fileEmpty" });
    expect(mocks.deleteObject).toHaveBeenCalledWith({
      objectKey: "content/empty.txt",
      bucket: null,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("keeps the buffered image validation path working", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n5sAAAAASUVORK5CYII=",
      "base64",
    );
    const file = new File([png], "pixel.png", { type: "image/png" });

    await saveUploadedFile({ file, purpose: "content_image", createdBy: "admin-1" });

    expect(mocks.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ body: png, contentType: "image/png" }),
    );
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1, height: 1, purpose: "content_image" }),
    );
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "file.cleanup_orphan",
        payload: { fileId: "file-1" },
        runAfter: expect.any(Date),
      }),
    );
  });
});

describe("stream upload file names", () => {
  it("decodes a safe UTF-8 file name", () => {
    expect(parseStreamFileName(encodeURIComponent("作品.mp4"))).toBe("作品.mp4");
  });

  it.each([
    null,
    "%E0%A4%A",
    "bad%0Aname.mp4",
    encodeURIComponent("folder/作品.mp4"),
    encodeURIComponent("folder\\作品.mp4"),
    encodeURIComponent("a".repeat(256)),
  ])("rejects unsafe header value %s", (value) => {
    expect(() => parseStreamFileName(value)).toThrow(ApiError);
  });
});
