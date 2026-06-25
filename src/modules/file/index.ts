import { randomUUID } from "crypto";
import { count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import path from "path";
import type { Readable } from "stream";

import { getDb } from "@/db";
import {
  type FileRecord,
  files,
  paymentMethods,
  paymentRequests,
  postFiles,
  posts,
  siteSettings,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { getUploadConfig } from "@/modules/config";
import { getStorage } from "@/modules/storage";
import { StorageObjectTooLargeError } from "@/modules/storage/stream";
import { recordEvent } from "@/modules/system/events";
import { enqueueTask } from "@/modules/tasks";

import { withAuthoritativeExtension } from "./authoritativeName";
import { deleteFileRowWithStorageTask } from "./cleanup";
import {
  normalizeRasterImage,
  UnsafeRasterImageError,
  UnsupportedRasterImageError,
} from "./normalizeRasterImage";

export type FilePurpose = FileRecord["purpose"];

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const CONTENT_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "zip",
  "psd",
  "clip",
  "brush",
  "abr",
  "procreate",
  "pdf",
  "txt",
  "mp4",
  "webm",
  "mov",
  "m4v",
];

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  zip: "application/zip",
  pdf: "application/pdf",
  txt: "text/plain",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
};

const MAX_ORIGINAL_FILE_NAME_LENGTH = 255;
const MAX_FILE_NAME_HEADER_LENGTH = 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const PURPOSE_RULES: Record<
  FilePurpose,
  { extensions: string[]; maxSizeMb: () => number | Promise<number> }
> = {
  artist_avatar: { extensions: IMAGE_EXTENSIONS, maxSizeMb: () => 10 },
  payment_qr: {
    extensions: IMAGE_EXTENSIONS,
    maxSizeMb: async () => (await getUploadConfig()).paymentProofMaxSizeMb,
  },
  payment_proof: {
    extensions: IMAGE_EXTENSIONS,
    maxSizeMb: async () => (await getUploadConfig()).paymentProofMaxSizeMb,
  },
  content_image: { extensions: [...IMAGE_EXTENSIONS, "gif"], maxSizeMb: () => 50 },
  content_attachment: {
    extensions: CONTENT_EXTENSIONS,
    maxSizeMb: async () => (await getUploadConfig()).maxUploadSizeMb,
  },
  cover: { extensions: IMAGE_EXTENSIONS, maxSizeMb: () => 20 },
  thumbnail: { extensions: IMAGE_EXTENSIONS, maxSizeMb: () => 20 },
};

const PURPOSE_DIRS: Record<FilePurpose, string> = {
  artist_avatar: "avatars",
  payment_qr: "payment-qr",
  payment_proof: "payment-proof",
  content_image: "content",
  content_attachment: "content",
  cover: "content",
  thumbnail: "content",
};

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.一-龥-]+/g, "_");
  return base.slice(-120) || "file";
}

function getExtension(name: string): string {
  return path.extname(name).replace(".", "").toLowerCase();
}

function validateOriginalFileName(name: string): string {
  if (!name || CONTROL_CHARACTERS.test(name) || name.includes("/") || name.includes("\\")) {
    throw new ApiError(400, "fileNameInvalid");
  }
  const base = path.posix.basename(name);
  if (!base || base === "." || base === ".." || base.length > MAX_ORIGINAL_FILE_NAME_LENGTH) {
    throw new ApiError(400, "fileNameInvalid");
  }
  return base;
}

export function parseStreamFileName(headerValue: string | null): string {
  if (!headerValue) throw new ApiError(400, "fileNameRequired");
  if (headerValue.length > MAX_FILE_NAME_HEADER_LENGTH) {
    throw new ApiError(400, "fileNameInvalid");
  }

  try {
    return validateOriginalFileName(decodeURIComponent(headerValue));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "fileNameInvalid");
  }
}

function normalizedContentType(fileName: string): string {
  return MIME_BY_EXTENSION[getExtension(fileName)] ?? "application/octet-stream";
}

async function getPurposeLimit(purpose: FilePurpose): Promise<{ maxMb: number; maxBytes: number }> {
  const rules = PURPOSE_RULES[purpose];
  if (!rules) throw new ApiError(400, "unsupportedFilePurpose");
  const maxMb = await rules.maxSizeMb();
  return { maxMb, maxBytes: maxMb * 1024 * 1024 };
}

export async function getContentAttachmentUploadLimit(): Promise<{
  maxMb: number;
  maxBytes: number;
}> {
  return getPurposeLimit("content_attachment");
}

function createObjectKey(purpose: FilePurpose, fileName: string, outputExt?: string): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const safeName = sanitizeFileName(fileName);
  const normalizedName = outputExt
    ? `${path.parse(safeName).name || "file"}.${outputExt}`
    : safeName;
  return `${PURPOSE_DIRS[purpose]}/${yyyy}/${mm}/${randomUUID()}-${normalizedName}`;
}

export async function saveUploadedFile(input: {
  file: File;
  purpose: FilePurpose;
  createdBy?: string | null;
}): Promise<FileRecord> {
  const { file, purpose } = input;
  if (purpose === "content_attachment") {
    throw new ApiError(400, "unsupportedFilePurpose");
  }
  const rules = PURPOSE_RULES[purpose];
  if (!rules) throw new ApiError(400, "unsupportedFilePurpose");
  const originalName = validateOriginalFileName(file.name);

  const ext = getExtension(originalName);
  if (!rules.extensions.includes(ext)) {
    throw new ApiError(400, "unsupportedFileType", {
      extension: ext,
      allowed: rules.extensions.join(", "),
    });
  }
  const maxMb = await rules.maxSizeMb();
  const maxBytes = maxMb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new ApiError(400, "fileTooLarge", { maxMb });
  }
  if (file.size === 0) {
    throw new ApiError(400, "fileEmpty");
  }

  const body = Buffer.from(await file.arrayBuffer());
  let normalized;
  try {
    normalized = await normalizeRasterImage(body, purpose);
  } catch (error) {
    if (error instanceof UnsupportedRasterImageError) {
      throw new ApiError(400, "unsupportedFileType");
    }
    if (error instanceof UnsafeRasterImageError) {
      throw new ApiError(400, "imageInvalid");
    }
    throw error;
  }
  if (normalized.sizeBytes > maxBytes) {
    throw new ApiError(400, "fileTooLarge", { maxMb });
  }

  const objectKey = createObjectKey(purpose, originalName, normalized.ext);
  const downloadName = withAuthoritativeExtension(originalName, normalized.ext);

  const storage = await getStorage();
  const stored = await storage.putObject({
    objectKey,
    body: normalized.outputBuffer,
    contentType: normalized.mimeType,
    contentDisposition:
      purpose === "payment_proof"
        ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
        : undefined,
  });

  let record: FileRecord;
  try {
    record = await getDb().transaction(async (tx) => {
      const [inserted] = await tx
        .insert(files)
        .values({
          storageDriver: storage.driver,
          bucket: stored.bucket,
          objectKey: stored.objectKey,
          originalName,
          mimeType: normalized.mimeType,
          sizeBytes: normalized.sizeBytes,
          sha256: normalized.sha256,
          width: normalized.width,
          height: normalized.height,
          purpose,
          createdBy: input.createdBy ?? null,
        })
        .returning();
      if (!inserted) throw new Error("文件记录写入失败");

      if (purpose === "content_image") {
        const gracePeriodMs = getEnv().INLINE_UPLOAD_GRACE_PERIOD_HOURS * 60 * 60 * 1000;
        await enqueueTask(tx, {
          kind: "file.cleanup_orphan",
          payload: { fileId: inserted.id },
          runAfter: new Date(Date.now() + gracePeriodMs),
        });
      }
      return inserted;
    });
  } catch (error) {
    await storage.deleteObject(stored);
    throw error;
  }

  await recordEvent("file_uploaded", {
    fileId: record.id,
    purpose,
    sizeBytes: file.size,
  });

  return record;
}

export async function saveStreamedFile(input: {
  body: Readable;
  fileName: string;
  purpose: FilePurpose;
  createdBy?: string | null;
  signal?: AbortSignal;
}): Promise<FileRecord> {
  if (input.purpose !== "content_attachment") {
    throw new ApiError(400, "unsupportedFilePurpose");
  }

  const fileName = validateOriginalFileName(input.fileName);
  const rules = PURPOSE_RULES.content_attachment;
  const extension = getExtension(fileName);
  if (!rules.extensions.includes(extension)) {
    throw new ApiError(400, "unsupportedFileType", {
      extension,
      allowed: rules.extensions.join(", "),
    });
  }

  const { maxMb, maxBytes } = await getPurposeLimit("content_attachment");
  const objectKey = createObjectKey("content_attachment", fileName);
  const storage = await getStorage();
  let streamed;
  try {
    streamed = await storage.putObjectStream({
      objectKey,
      body: input.body,
      contentType: normalizedContentType(fileName),
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      maxBytes,
      signal: input.signal,
    });
  } catch (err) {
    if (err instanceof StorageObjectTooLargeError) {
      throw new ApiError(413, "fileTooLarge", { maxMb });
    }
    throw err;
  }

  if (streamed.sizeBytes === 0) {
    await storage.deleteObject(streamed.stored);
    throw new ApiError(400, "fileEmpty");
  }

  let record: FileRecord;
  try {
    const [inserted] = await getDb()
      .insert(files)
      .values({
        storageDriver: storage.driver,
        bucket: streamed.stored.bucket,
        objectKey: streamed.stored.objectKey,
        originalName: fileName,
        mimeType: normalizedContentType(fileName),
        sizeBytes: streamed.sizeBytes,
        sha256: streamed.sha256,
        width: null,
        height: null,
        purpose: "content_attachment",
        createdBy: input.createdBy ?? null,
      })
      .returning();
    if (!inserted) throw new Error("文件记录写入失败");
    record = inserted;
  } catch (err) {
    await storage.deleteObject(streamed.stored);
    throw err;
  }

  await recordEvent("file_uploaded", {
    fileId: record.id,
    purpose: "content_attachment",
    sizeBytes: streamed.sizeBytes,
  });

  return record;
}

export async function getFileById(id: string): Promise<FileRecord | null> {
  const [record] = await getDb().select().from(files).where(eq(files.id, id)).limit(1);
  return record ?? null;
}

export async function listFiles(): Promise<FileRecord[]> {
  return getDb()
    .select()
    .from(files)
    .where(isNull(files.quarantinedAt))
    .orderBy(desc(files.createdAt));
}

export async function listQuarantinedFiles() {
  return getDb()
    .select({
      id: files.id,
      purpose: files.purpose,
      originalName: files.originalName,
      quarantineReason: files.quarantineReason,
      quarantinedAt: files.quarantinedAt,
    })
    .from(files)
    .where(isNotNull(files.quarantinedAt))
    .orderBy(desc(files.quarantinedAt));
}

const PROTECTED_SETTING_KEYS = [
  "artist_avatar_file_id",
  "site_logo_file_id",
  "site_icon_file_id",
] as const;

export async function deleteFile(id: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [record] = await tx.select().from(files).where(eq(files.id, id)).limit(1).for("update");
    if (!record) throw new ApiError(404, "fileNotFound");
    if (record.quarantinedAt) throw new ApiError(410, "fileQuarantined");

    const [[postFile], [qr], [cover], [proof], settingRows] = await Promise.all([
      tx.select({ c: count() }).from(postFiles).where(eq(postFiles.fileId, id)),
      tx.select({ c: count() }).from(paymentMethods).where(eq(paymentMethods.qrFileId, id)),
      tx.select({ c: count() }).from(posts).where(eq(posts.coverFileId, id)),
      tx.select({ c: count() }).from(paymentRequests).where(eq(paymentRequests.proofFileId, id)),
      tx
        .select({ value: siteSettings.valueJson })
        .from(siteSettings)
        .where(inArray(siteSettings.key, [...PROTECTED_SETTING_KEYS])),
    ]);
    const params = {
      postFiles: Number(postFile.c),
      paymentMethods: Number(qr.c),
      covers: Number(cover.c),
      proofs: Number(proof.c),
      settings: settingRows.filter((row) => row.value === id).length,
    };
    if (Object.values(params).some((value) => value > 0)) {
      throw new ApiError(400, "fileInUse", params);
    }

    await deleteFileRowWithStorageTask(tx, record);
  });
}
