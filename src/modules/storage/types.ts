import type { Readable } from "stream";

export type PutObjectInput = {
  objectKey: string;
  body: Buffer;
  contentType: string;
};

export type PutObjectStreamInput = {
  objectKey: string;
  body: Readable;
  contentType: string;
  maxBytes: number;
  signal?: AbortSignal;
};

export type StoredObject = {
  objectKey: string;
  bucket: string | null;
};

export type GetObjectInput = {
  objectKey: string;
  bucket?: string | null;
  start?: number;
  end?: number;
};

export type DeleteObjectInput = {
  objectKey: string;
  bucket?: string | null;
};

export type SignedUrlInput = {
  objectKey: string;
  bucket?: string | null;
  expiresInSeconds: number;
  downloadName?: string;
  disposition?: "inline" | "attachment";
  contentType?: string;
};

export interface StorageAdapter {
  driver: "local" | "s3";
  putObject(input: PutObjectInput): Promise<StoredObject>;
  putObjectStream(input: PutObjectStreamInput): Promise<{
    stored: StoredObject;
    sizeBytes: number;
    sha256: string;
  }>;
  getObject(input: GetObjectInput): Promise<Readable>;
  deleteObject(input: DeleteObjectInput): Promise<void>;
  createSignedDownloadUrl?(input: SignedUrlInput): Promise<string>;
}
