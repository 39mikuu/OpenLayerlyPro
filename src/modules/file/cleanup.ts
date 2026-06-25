import { createHash } from "crypto";
import { eq, inArray } from "drizzle-orm";

import { getDb, type TxClient } from "@/db";
import {
  files,
  paymentMethods,
  paymentRequests,
  postFiles,
  posts,
  siteSettings,
} from "@/db/schema";
import { getStorageForDriver } from "@/modules/storage";
import { enqueueTask } from "@/modules/tasks";

export type StorageDeletePayload = {
  storageDriver: "local" | "s3";
  bucket: string | null;
  objectKey: string;
};

export class UnsupportedOrphanCleanupPurposeError extends Error {}

const PROTECTED_SETTING_KEYS = [
  "artist_avatar_file_id",
  "site_logo_file_id",
  "site_icon_file_id",
] as const;

export function storageDeleteDedupeKey(payload: StorageDeletePayload): string {
  const identity = `${payload.storageDriver}\0${payload.bucket ?? ""}\0${payload.objectKey}`;
  const hash = createHash("sha256").update(identity).digest("hex");
  return `storage:delete_object:${hash}`;
}

export async function cleanupOrphanFile(
  fileId: string,
): Promise<"missing" | "referenced" | "deleted"> {
  return getDb().transaction(async (tx) => {
    const [file] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1).for("update");
    if (!file) return "missing";
    if (file.purpose !== "content_image") {
      throw new UnsupportedOrphanCleanupPurposeError(
        `Purpose ${file.purpose} is not eligible for orphan cleanup`,
      );
    }

    const [postFileRef] = await tx
      .select({ id: postFiles.id })
      .from(postFiles)
      .where(eq(postFiles.fileId, fileId))
      .limit(1);
    const [coverRef] = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.coverFileId, fileId))
      .limit(1);
    const [paymentMethodRef] = await tx
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(eq(paymentMethods.qrFileId, fileId))
      .limit(1);
    const [paymentProofRef] = await tx
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(eq(paymentRequests.proofFileId, fileId))
      .limit(1);
    const settingRefs = await tx
      .select({ value: siteSettings.valueJson })
      .from(siteSettings)
      .where(inArray(siteSettings.key, [...PROTECTED_SETTING_KEYS]));

    if (
      postFileRef ||
      coverRef ||
      paymentMethodRef ||
      paymentProofRef ||
      settingRefs.some((setting) => setting.value === fileId)
    ) {
      return "referenced";
    }

    await deleteFileRowWithStorageTask(tx, file);
    return "deleted";
  });
}

export async function enqueueFileStorageDeletion(
  tx: TxClient,
  file: Pick<typeof files.$inferSelect, "storageDriver" | "bucket" | "objectKey">,
): Promise<void> {
  const payload: StorageDeletePayload = {
    storageDriver: file.storageDriver,
    bucket: file.bucket,
    objectKey: file.objectKey,
  };
  await enqueueTask(tx, {
    kind: "storage.delete_object",
    dedupeKey: storageDeleteDedupeKey(payload),
    payload,
  });
}

export async function deleteFileRowWithStorageTask(
  tx: TxClient,
  file: Pick<typeof files.$inferSelect, "id" | "storageDriver" | "bucket" | "objectKey">,
): Promise<void> {
  await enqueueFileStorageDeletion(tx, file);
  await tx.delete(files).where(eq(files.id, file.id));
}

export async function deleteStorageObject(payload: StorageDeletePayload): Promise<void> {
  const storage = await getStorageForDriver(payload.storageDriver);
  await storage.deleteObject({ objectKey: payload.objectKey, bucket: payload.bucket });
}

export function createStorageDeleteDedupeKeyForTests(payload: StorageDeletePayload): string {
  return storageDeleteDedupeKey(payload);
}
