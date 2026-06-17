import type { Readable } from "stream";

export type PutObjectInput = {
  objectKey: string;
  body: Buffer;
  contentType: string;
};

export type StoredObject = {
  objectKey: string;
  bucket: string | null;
};

export type GetObjectInput = {
  objectKey: string;
  bucket?: string | null;
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
};

export interface StorageAdapter {
  driver: "local" | "s3";
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(input: GetObjectInput): Promise<Readable>;
  deleteObject(input: DeleteObjectInput): Promise<void>;
  createSignedDownloadUrl?(input: SignedUrlInput): Promise<string>;
}
