import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { S3_UPLOAD_PART_SIZE, S3_UPLOAD_QUEUE_SIZE, S3StorageAdapter } from "./s3";
import { StorageObjectTooLargeError } from "./stream";

const state = vi.hoisted(() => ({
  abortMock: vi.fn(),
  doneError: null as Error | null,
  sendMock: vi.fn(),
  uploadOptions: [] as Array<{
    params: { Body: AsyncIterable<Uint8Array> };
    queueSize: number;
    partSize: number;
    leavePartsOnError: boolean;
  }>,
  uploadedBodies: [] as Buffer[],
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: vi.fn(
      class MockS3Client {
        send = state.sendMock;
      },
    ),
  };
});

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class MockUpload {
    private options: (typeof state.uploadOptions)[number];

    constructor(options: (typeof state.uploadOptions)[number]) {
      this.options = options;
      state.uploadOptions.push(options);
    }

    async done() {
      const chunks: Buffer[] = [];
      for await (const chunk of this.options.params.Body) {
        chunks.push(Buffer.from(chunk));
      }
      state.uploadedBodies.push(Buffer.concat(chunks));
      if (state.doneError) throw state.doneError;
      return {};
    }

    async abort() {
      state.abortMock();
    }
  },
}));

const config = {
  endpoint: "https://s3.example.com",
  region: "auto",
  bucket: "test-bucket",
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
  forcePathStyle: true,
};

describe("S3StorageAdapter", () => {
  afterEach(() => {
    vi.clearAllMocks();
    state.doneError = null;
    state.uploadOptions.length = 0;
    state.uploadedBodies.length = 0;
  });

  it("连接测试执行 Put、Get 内容校验和 Delete 闭环", async () => {
    let uploaded = Buffer.alloc(0);
    state.sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        uploaded = Buffer.from(command.input.Body as Uint8Array);
        return {};
      }
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([uploaded]) };
      }
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("unexpected command");
    });

    const adapter = new S3StorageAdapter(config);
    await adapter.testConnection();

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
      }),
    );
    expect(state.sendMock).toHaveBeenCalledTimes(3);
    expect(state.sendMock.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(state.sendMock.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect(state.sendMock.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("读取失败时仍尝试删除临时对象", async () => {
    state.sendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce({});

    const adapter = new S3StorageAdapter(config);
    await expect(adapter.testConnection()).rejects.toThrow("read failed");
    expect(state.sendMock).toHaveBeenCalledTimes(3);
    expect(state.sendMock.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("历史对象操作优先使用文件记录中的 bucket", async () => {
    state.sendMock.mockResolvedValue({});
    const adapter = new S3StorageAdapter(config);

    await adapter.deleteObject({ objectKey: "old/file.txt", bucket: "historical-bucket" });

    const command = state.sendMock.mock.calls[0][0] as DeleteObjectCommand;
    expect(command.input.Bucket).toBe("historical-bucket");
  });

  it("uses bounded multipart settings and streams bytes without whole-file buffering", async () => {
    const adapter = new S3StorageAdapter(config);
    const body = Buffer.from("multipart body");

    const result = await adapter.putObjectStream({
      objectKey: "content/video.mp4",
      body: Readable.from([body.subarray(0, 4), body.subarray(4)]),
      contentType: "video/mp4",
      maxBytes: 1024,
    });

    expect(state.uploadOptions).toHaveLength(1);
    expect(state.uploadOptions[0]).toEqual(
      expect.objectContaining({
        queueSize: S3_UPLOAD_QUEUE_SIZE,
        partSize: S3_UPLOAD_PART_SIZE,
        leavePartsOnError: false,
      }),
    );
    expect(state.uploadedBodies).toEqual([body]);
    expect(result).toEqual(
      expect.objectContaining({
        sizeBytes: body.length,
        stored: { objectKey: "content/video.mp4", bucket: "test-bucket" },
      }),
    );
  });

  it("aborts multipart and removes a possible object when the measured stream is too large", async () => {
    state.sendMock.mockResolvedValue({});
    const adapter = new S3StorageAdapter(config);

    await expect(
      adapter.putObjectStream({
        objectKey: "content/too-large.zip",
        body: Readable.from([Buffer.alloc(32)]),
        contentType: "application/zip",
        maxBytes: 16,
      }),
    ).rejects.toBeInstanceOf(StorageObjectTooLargeError);

    expect(state.abortMock).toHaveBeenCalledTimes(1);
    expect(state.sendMock.mock.calls.at(-1)?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("aborts multipart and cleans the object when the request signal is cancelled", async () => {
    state.sendMock.mockResolvedValue({});
    const adapter = new S3StorageAdapter(config);
    const controller = new AbortController();
    async function* chunks() {
      while (true) {
        yield Buffer.alloc(1024);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const upload = adapter.putObjectStream({
      objectKey: "content/aborted.webm",
      body: Readable.from(chunks()),
      contentType: "video/webm",
      maxBytes: 1024 * 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 15);

    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(state.abortMock).toHaveBeenCalledTimes(1);
    expect(state.sendMock.mock.calls.at(-1)?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });
});
