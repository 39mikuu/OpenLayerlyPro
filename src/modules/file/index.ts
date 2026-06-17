import { createHash, randomUUID } from "crypto";
import { and, count, desc, eq } from "drizzle-orm";
import path from "path";
import sharp from "sharp";

import { getDb } from "@/db";
import { type FileRecord, files, paymentMethods, paymentRequests, posts } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getUploadConfig } from "@/modules/config";
import { getSetting } from "@/modules/site";
import { getStorage, getStorageForDriver } from "@/modules/storage";
import { recordEvent } from "@/modules/system/events";

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
];

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

export async function saveUploadedFile(input: {
  file: File;
  purpose: FilePurpose;
  createdBy?: string | null;
}): Promise<FileRecord> {
  const { file, purpose } = input;
  const rules = PURPOSE_RULES[purpose];
  if (!rules) throw new ApiError(400, "unsupportedFilePurpose");

  const ext = getExtension(file.name);
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
  const sha = createHash("sha256").update(body).digest("hex");

  let width: number | null = null;
  let height: number | null = null;
  if (IMAGE_EXTENSIONS.includes(ext) || ext === "gif") {
    try {
      const meta = await sharp(body).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
    } catch {
      throw new ApiError(400, "imageInvalid");
    }
  }

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const safeName = sanitizeFileName(file.name);
  const objectKey = `${PURPOSE_DIRS[purpose]}/${yyyy}/${mm}/${randomUUID()}-${safeName}`;

  const storage = await getStorage();
  const stored = await storage.putObject({
    objectKey,
    body,
    contentType: file.type || "application/octet-stream",
  });

  const [record] = await getDb()
    .insert(files)
    .values({
      storageDriver: storage.driver,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      originalName: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      sha256: sha,
      width,
      height,
      purpose,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  await recordEvent("file_uploaded", {
    fileId: record.id,
    purpose,
    sizeBytes: file.size,
  });

  return record;
}

export async function getFileById(id: string): Promise<FileRecord | null> {
  const [record] = await getDb().select().from(files).where(eq(files.id, id)).limit(1);
  return record ?? null;
}

export async function listFiles(): Promise<FileRecord[]> {
  return getDb().select().from(files).orderBy(desc(files.createdAt));
}

/** 删除会破坏功能的引用检查；post_files 关联会随删除级联解除，不在此列 */
async function assertFileNotReferenced(id: string): Promise<void> {
  const db = getDb();
  const [[qr], [cover], [proof]] = await Promise.all([
    db.select({ c: count() }).from(paymentMethods).where(eq(paymentMethods.qrFileId, id)),
    db.select({ c: count() }).from(posts).where(eq(posts.coverFileId, id)),
    db
      .select({ c: count() })
      .from(paymentRequests)
      .where(
        and(eq(paymentRequests.proofFileId, id), eq(paymentRequests.status, "pending_review")),
      ),
  ]);
  const [avatarFileId, logoFileId, iconFileId] = await Promise.all([
    getSetting<string>("artist_avatar_file_id"),
    getSetting<string>("site_logo_file_id"),
    getSetting<string>("site_icon_file_id"),
  ]);
  const avatar = avatarFileId === id ? 1 : 0;
  const siteLogo = logoFileId === id ? 1 : 0;
  const siteIcon = iconFileId === id ? 1 : 0;
  const params = {
    paymentMethods: Number(qr.c),
    covers: Number(cover.c),
    proofs: Number(proof.c),
    avatar,
    siteLogo,
    siteIcon,
  };
  if (Object.values(params).some((value) => value > 0)) {
    throw new ApiError(400, "fileInUse", params);
  }
}

export async function deleteFile(id: string): Promise<void> {
  const record = await getFileById(id);
  if (!record) throw new ApiError(404, "fileNotFound");
  await assertFileNotReferenced(id);
  const storage = await getStorageForDriver(record.storageDriver);
  await storage.deleteObject({ objectKey: record.objectKey, bucket: record.bucket });
  await getDb().delete(files).where(eq(files.id, id));
}
