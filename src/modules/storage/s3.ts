import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { createMeasuredStream } from "./stream";
import type {
  DeleteObjectInput,
  GetObjectInput,
  PutObjectInput,
  PutObjectStreamInput,
  SignedUrlInput,
  StorageAdapter,
  StoredObject,
} from "./types";

export const S3_UPLOAD_QUEUE_SIZE = 2;
export const S3_UPLOAD_PART_SIZE = 8 * 1024 * 1024;

export type S3StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

function exactHttpsResourceOrigin(value: string): string | null {
  try {
    if (!value || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hostname.includes("*")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export async function resolveS3SignedDownloadOrigin(
  config: S3StorageConfig,
): Promise<string | null> {
  if (!exactHttpsResourceOrigin(config.endpoint)) return null;
  const adapter = new S3StorageAdapter(config);
  const signedUrl = await adapter.createSignedDownloadUrl({
    objectKey: ".openlayerlypro/csp-origin",
    expiresInSeconds: 60,
    disposition: "inline",
  });
  try {
    return exactHttpsResourceOrigin(signedUrl);
  } catch {
    return null;
  }
}

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
        ContentDisposition: input.contentDisposition,
      }),
    );
    return { objectKey: input.objectKey, bucket: this.bucket };
  }

  async putObjectStream(input: PutObjectStreamInput): Promise<{
    stored: StoredObject;
    sizeBytes: number;
    sha256: string;
  }> {
    const measured = createMeasuredStream(input.maxBytes);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: input.objectKey,
        Body: measured.stream,
        ContentType: input.contentType,
        ContentDisposition: input.contentDisposition,
      },
      queueSize: S3_UPLOAD_QUEUE_SIZE,
      partSize: S3_UPLOAD_PART_SIZE,
      leavePartsOnError: false,
    });

    try {
      await Promise.all([
        pipeline(input.body, measured.stream, { signal: input.signal }),
        upload.done(),
      ]);
      input.signal?.throwIfAborted();
      return {
        stored: { objectKey: input.objectKey, bucket: this.bucket },
        ...measured.result(),
      };
    } catch (err) {
      input.body.destroy(err instanceof Error ? err : undefined);
      await upload.abort().catch(() => undefined);
      await this.client
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: input.objectKey }))
        .catch(() => undefined);
      throw err;
    }
  }

  async getObject(input: GetObjectInput): Promise<Readable> {
    const range =
      input.start !== undefined || input.end !== undefined
        ? `bytes=${input.start ?? 0}-${input.end ?? ""}`
        : undefined;
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: input.bucket ?? this.bucket,
        Key: input.objectKey,
        Range: range,
      }),
    );
    return res.Body as Readable;
  }

  async deleteObject(input: DeleteObjectInput): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: input.bucket ?? this.bucket, Key: input.objectKey }),
    );
  }

  async createSignedDownloadUrl(input: SignedUrlInput): Promise<string> {
    const disposition = input.disposition ?? "attachment";
    const command = new GetObjectCommand({
      Bucket: input.bucket ?? this.bucket,
      Key: input.objectKey,
      ResponseContentDisposition: input.downloadName
        ? `${disposition}; filename*=UTF-8''${encodeURIComponent(input.downloadName)}`
        : undefined,
      ResponseContentType: input.contentType,
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
