import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { Readable } from "stream";

import type {
  DeleteObjectInput,
  GetObjectInput,
  PutObjectInput,
  SignedUrlInput,
  StorageAdapter,
  StoredObject,
} from "./types";

export type S3StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new Error("S3 测试对象响应为空");

  const sdkBody = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof sdkBody.transformToByteArray === "function") {
    return Buffer.from(await sdkBody.transformToByteArray());
  }

  if (body instanceof Readable || Symbol.asyncIterator in Object(body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("无法读取 S3 测试对象响应");
}

export class S3StorageAdapter implements StorageAdapter {
  driver = "s3" as const;
  private client: S3Client;
  private bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
    return { objectKey: input.objectKey, bucket: this.bucket };
  }

  async getObject(input: GetObjectInput): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: input.bucket ?? this.bucket, Key: input.objectKey }),
    );
    return res.Body as Readable;
  }

  async deleteObject(input: DeleteObjectInput): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: input.bucket ?? this.bucket, Key: input.objectKey }),
    );
  }

  async createSignedDownloadUrl(input: SignedUrlInput): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: input.bucket ?? this.bucket,
      Key: input.objectKey,
      ResponseContentDisposition: input.downloadName
        ? `attachment; filename*=UTF-8''${encodeURIComponent(input.downloadName)}`
        : undefined,
    });
    return getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds });
  }

  /**
   * 使用随机临时对象验证写入、读取和删除能力。
   * 任一步失败仍会尝试删除，避免连接测试留下垃圾对象。
   */
  async testConnection(): Promise<void> {
    const objectKey = `.openlayerlypro/connection-test/${randomUUID()}.txt`;
    const expected = Buffer.from(`openlayerlypro-storage-test:${randomUUID()}`, "utf8");
    let operationError: unknown;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: expected,
          ContentType: "text/plain",
        }),
      );
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      const actual = await streamToBuffer(result.Body);
      if (!actual.equals(expected)) {
        throw new Error("S3 测试对象读取内容不一致");
      }
    } catch (err) {
      operationError = err;
      throw err;
    } finally {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      } catch (cleanupError) {
        if (!operationError) throw cleanupError;
      }
    }
  }
}
