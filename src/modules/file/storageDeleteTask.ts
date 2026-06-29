import { createHash } from "crypto";

export type StorageDeletePayload = {
  storageDriver: "local" | "s3";
  bucket: string | null;
  objectKey: string;
};

export function storageDeleteDedupeKey(payload: StorageDeletePayload): string {
  const identity = `${payload.storageDriver}\0${payload.bucket ?? ""}\0${payload.objectKey}`;
  const hash = createHash("sha256").update(identity).digest("hex");
  return `storage:delete_object:${hash}`;
}
