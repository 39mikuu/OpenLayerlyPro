import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Readable } from "stream";

import { type DbClient, getDb } from "@/db";
import { appEvents, type FileRecord, files } from "@/db/schema";
import { getUploadConfig } from "@/modules/config";
import { getStorageForDriver } from "@/modules/storage";
import { enqueueTask } from "@/modules/tasks";

import { withAuthoritativeExtension } from "./authoritativeName";
import {
  normalizeRasterImage,
  type RasterImagePurpose,
  UnsafeRasterImageError,
  UnsupportedRasterImageError,
} from "./normalizeRasterImage";

export const FILE_SAFETY_REMEDIATION_VERSION = 1;
const FILE_SAFETY_BACKFILL_LOCK_KEY = `file-safety-backfill:v${FILE_SAFETY_REMEDIATION_VERSION}`;

export class FileSafetyBackfillAlreadyRunningError extends Error {
  constructor() {
    super("File safety backfill is already running");
    this.name = "FileSafetyBackfillAlreadyRunningError";
  }
}

export const FILE_SAFETY_IMAGE_PURPOSES = [
  "artist_avatar",
  "payment_qr",
  "payment_proof",
  "content_image",
  "cover",
  "thumbnail",
] as const satisfies readonly RasterImagePurpose[];

export type FileSafetyBackfillResult = {
  scanned: number;
  remediated: number;
  quarantined: number;
  oversize: number;
  dryRun: boolean;
};

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function maxBytesForPurpose(purpose: RasterImagePurpose): Promise<number> {
  if (purpose === "artist_avatar") return 10 * 1024 * 1024;
  if (purpose === "content_image") return 50 * 1024 * 1024;
  if (purpose === "cover" || purpose === "thumbnail") return 20 * 1024 * 1024;
  const config = await getUploadConfig();
  return config.paymentProofMaxSizeMb * 1024 * 1024;
}

function quarantineReason(error: unknown): string {
  if (error instanceof UnsupportedRasterImageError) {
    return `unsupported-format:${error.detectedFormat ?? "unknown"}`;
  }
  if (error instanceof UnsafeRasterImageError) return `unsafe-image:${error.reason}`;
  return "unsafe-image:unknown";
}

function attachmentDisposition(file: FileRecord, outputExt: string): string | undefined {
  return file.purpose === "payment_proof"
    ? `attachment; filename*=UTF-8''${encodeURIComponent(withAuthoritativeExtension(file.originalName, outputExt))}`
    : undefined;
}

async function quarantineFile(file: FileRecord, reason: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(files)
      .set({
        quarantinedAt: sql`now()`,
        quarantineReason: reason,
        remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(files.id, file.id),
          eq(files.objectKey, file.objectKey),
          lt(files.remediationVersion, FILE_SAFETY_REMEDIATION_VERSION),
        ),
      )
      .returning({ id: files.id });
    if (!updated) return false;

    await tx.insert(appEvents).values({
      type: "file_safety_quarantined",
      payloadJson: {
        fileId: file.id,
        purpose: file.purpose,
        originalMimeType: file.mimeType,
        reason,
        remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
      },
    });
    return true;
  });
}

async function switchRemediatedObject(input: {
  file: FileRecord;
  objectKey: string;
  bucket: string | null;
  output: Awaited<ReturnType<typeof normalizeRasterImage>>;
  oversize: boolean;
}): Promise<boolean> {
  const { file, objectKey, bucket, output, oversize } = input;
  return getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(files)
      .set({
        bucket,
        objectKey,
        mimeType: output.mimeType,
        sizeBytes: output.sizeBytes,
        sha256: output.sha256,
        width: output.width,
        height: output.height,
        quarantinedAt: null,
        quarantineReason: null,
        remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(files.id, file.id),
          eq(files.objectKey, file.objectKey),
          lt(files.remediationVersion, FILE_SAFETY_REMEDIATION_VERSION),
        ),
      )
      .returning({ id: files.id });
    if (!updated) return false;

    await enqueueTask(tx, {
      kind: "storage.delete_object",
      dedupeKey: `file-safety:v${FILE_SAFETY_REMEDIATION_VERSION}:delete:${file.id}`,
      payload: {
        storageDriver: file.storageDriver,
        bucket: file.bucket,
        objectKey: file.objectKey,
      },
    });
    await tx.insert(appEvents).values({
      type: oversize ? "file_safety_remediated_oversize" : "file_safety_remediated",
      payloadJson: {
        fileId: file.id,
        purpose: file.purpose,
        originalMimeType: file.mimeType,
        inputFormat: output.inputFormat,
        outputMimeType: output.mimeType,
        outputSizeBytes: output.sizeBytes,
        oversizeAfterReencode: oversize,
        remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
      },
    });
    return true;
  });
}

async function runFileSafetyBackfillWithDb(
  db: DbClient,
  options: {
    apply?: boolean;
    batchSize?: number;
    onProgress?: (message: string) => void;
  },
): Promise<FileSafetyBackfillResult> {
  const apply = options.apply === true;
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1_000);
  const result: FileSafetyBackfillResult = {
    scanned: 0,
    remediated: 0,
    quarantined: 0,
    oversize: 0,
    dryRun: !apply,
  };
  let cursor: string | undefined;

  for (;;) {
    const conditions = [
      inArray(files.purpose, [...FILE_SAFETY_IMAGE_PURPOSES]),
      lt(files.remediationVersion, FILE_SAFETY_REMEDIATION_VERSION),
    ];
    if (cursor) conditions.push(gt(files.id, cursor));
    const batch = await db
      .select()
      .from(files)
      .where(and(...conditions))
      .orderBy(asc(files.id))
      .limit(batchSize);
    if (batch.length === 0) break;

    for (const file of batch) {
      cursor = file.id;
      result.scanned += 1;
      const storage = await getStorageForDriver(file.storageDriver);
      const stream = await storage.getObject({ objectKey: file.objectKey, bucket: file.bucket });
      const input = await streamToBuffer(stream);
      let output: Awaited<ReturnType<typeof normalizeRasterImage>>;
      try {
        output = await normalizeRasterImage(input, file.purpose as RasterImagePurpose);
      } catch (error) {
        if (
          !(error instanceof UnsupportedRasterImageError) &&
          !(error instanceof UnsafeRasterImageError)
        ) {
          throw error;
        }
        const reason = quarantineReason(error);
        options.onProgress?.(`${apply ? "quarantine" : "would quarantine"} ${file.id}: ${reason}`);
        if (!apply || (await quarantineFile(file, reason))) result.quarantined += 1;
        continue;
      }

      const maxBytes = await maxBytesForPurpose(file.purpose as RasterImagePurpose);
      const oversize = output.sizeBytes > maxBytes;
      if (oversize) result.oversize += 1;
      const newObjectKey = `remediated/v${FILE_SAFETY_REMEDIATION_VERSION}/${file.id}.${output.ext}`;
      options.onProgress?.(
        `${apply ? "remediate" : "would remediate"} ${file.id} -> ${newObjectKey}${oversize ? " (oversize retained)" : ""}`,
      );
      if (!apply) {
        result.remediated += 1;
        continue;
      }

      const stored = await storage.putObject({
        objectKey: newObjectKey,
        body: output.outputBuffer,
        contentType: output.mimeType,
        contentDisposition: attachmentDisposition(file, output.ext),
      });
      if (
        await switchRemediatedObject({
          file,
          objectKey: stored.objectKey,
          bucket: stored.bucket,
          output,
          oversize,
        })
      ) {
        result.remediated += 1;
      }
    }

    if (batch.length < batchSize) break;
  }

  return result;
}

export async function runFileSafetyBackfill(
  options: {
    apply?: boolean;
    batchSize?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<FileSafetyBackfillResult> {
  if (options.apply !== true) {
    return runFileSafetyBackfillWithDb(getDb(), options);
  }

  return getDb().transaction(async (tx) => {
    const lockResult = await tx.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${FILE_SAFETY_BACKFILL_LOCK_KEY}, 0)) as acquired`,
    );
    if (lockResult[0]?.acquired !== true) {
      throw new FileSafetyBackfillAlreadyRunningError();
    }
    return runFileSafetyBackfillWithDb(getDb(), options);
  });
}
