import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { S3StorageAdapter } from "./s3";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: vi.fn(
      class MockS3Client {
        send = sendMock;
      },
    ),
  };
});

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
  });

  it("连接测试执行 Put、Get 内容校验和 Delete 闭环", async () => {
    let uploaded = Buffer.alloc(0);
    sendMock.mockImplementation(async (command: unknown) => {
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
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(sendMock.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect(sendMock.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("读取失败时仍尝试删除临时对象", async () => {
    sendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce({});

    const adapter = new S3StorageAdapter(config);
    await expect(adapter.testConnection()).rejects.toThrow("read failed");
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("历史对象操作优先使用文件记录中的 bucket", async () => {
    sendMock.mockResolvedValue({});
    const adapter = new S3StorageAdapter(config);

    await adapter.deleteObject({ objectKey: "old/file.txt", bucket: "historical-bucket" });

    const command = sendMock.mock.calls[0][0] as DeleteObjectCommand;
    expect(command.input.Bucket).toBe("historical-bucket");
  });
});
