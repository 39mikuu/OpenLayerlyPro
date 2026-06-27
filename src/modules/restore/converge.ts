import { and, asc, eq, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { files, tasks } from "@/db/schema";
import { getStorageConfig, type ResolvedStorageConfig } from "@/modules/config/storageResolve";
import { FILE_SAFETY_REMEDIATION_VERSION } from "@/modules/file/safetyConstants";
import {
  storageDeleteDedupeKey,
  type StorageDeletePayload,
} from "@/modules/file/storageDeleteTask";
import type { StorageDriver } from "@/modules/storage/runtime";
import { enqueueTask } from "@/modules/tasks/enqueue";

import { enumerateStorageObjects, objectExists, storageObjectIdentity } from "./storageProbe";
import type { ConvergeDriverReport, ConvergeReport, RestoreScanError } from "./types";

const MISSING_AFTER_RESTORE_REASON = "missing after restore";

type ReferencedObject = {
  storageDriver: StorageDriver;
  bucket: string | null;
  objectKey: string;
};

async function quarantineMissingFile(db: DbClient, fileId: string): Promise<boolean> {
  const [updated] = await db
    .update(files)
    .set({
      quarantinedAt: sql`now()`,
      quarantineReason: MISSING_AFTER_RESTORE_REASON,
      remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
      updatedAt: sql`now()`,
    })
    .where(eq(files.id, fileId))
    .returning({ id: files.id });
  return Boolean(updated);
}

async function enqueueOrphanDeletion(
  db: DbClient,
  payload: StorageDeletePayload,
): Promise<boolean> {
  const dedupeKey = storageDeleteDedupeKey(payload);
  const existing = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.kind, "storage.delete_object"), eq(tasks.dedupeKey, dedupeKey)))
    .limit(1);
  if (existing.length > 0) return false;

  await db.transaction(async (tx) => {
    await enqueueTask(tx, {
      kind: "storage.delete_object",
      dedupeKey,
      payload,
    });
  });
  return true;
}

async function convergeDriver(input: {
  db: DbClient;
  driver: StorageDriver;
  storageConfig: ResolvedStorageConfig;
  referenced: ReferencedObject[];
  pageSize?: number;
  maxObjects?: number;
  prefix?: string;
  prefixes?: string | readonly string[];
}): Promise<ConvergeDriverReport> {
  const report: ConvergeDriverReport = {
    driver: input.driver,
    bucket: input.driver === "s3" ? (input.storageConfig.bucket ?? null) : null,
    referencedScanned: 0,
    missingReferenced: 0,
    newlyQuarantined: 0,
    storageObjectsEnumerated: 0,
    orphanObjects: 0,
    orphanDeletesEnqueued: 0,
    truncated: false,
    errors: [],
  };

  const referencedByIdentity = new Map<string, ReferencedObject[]>();
  for (const object of input.referenced) {
    const identity = storageObjectIdentity(object.storageDriver, object.bucket, object.objectKey);
    const bucket = referencedByIdentity.get(identity) ?? [];
    bucket.push(object);
    referencedByIdentity.set(identity, bucket);
    report.referencedScanned += 1;
  }

  for (const [identity, objects] of referencedByIdentity) {
    const sample = objects[0]!;
    try {
      const exists = await objectExists({
        driver: sample.storageDriver,
        bucket: sample.bucket,
        objectKey: sample.objectKey,
      });
      if (exists) continue;

      report.missingReferenced += 1;
      for (const object of objects) {
        const fileRows = await input.db
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              eq(files.storageDriver, object.storageDriver),
              eq(files.objectKey, object.objectKey),
              object.bucket === null
                ? sql`${files.bucket} is null`
                : eq(files.bucket, object.bucket),
            ),
          );
        for (const file of fileRows) {
          if (await quarantineMissingFile(input.db, file.id)) {
            report.newlyQuarantined += 1;
          }
        }
      }
    } catch (error) {
      report.errors.push({
        objectKey: sample.objectKey,
        message: `${identity}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  try {
    const enumerated = await enumerateStorageObjects({
      driver: input.driver,
      storageConfig: input.storageConfig,
      pageSize: input.pageSize,
      maxObjects: input.maxObjects,
      prefix: input.prefix,
      prefixes: input.prefixes,
    });
    report.storageObjectsEnumerated = enumerated.objectKeys.length;
    report.truncated = enumerated.truncated;

    for (const objectKey of enumerated.objectKeys) {
      const identity = storageObjectIdentity(input.driver, report.bucket, objectKey);
      if (referencedByIdentity.has(identity)) continue;
      report.orphanObjects += 1;
      try {
        const enqueued = await enqueueOrphanDeletion(input.db, {
          storageDriver: input.driver,
          bucket: report.bucket,
          objectKey,
        });
        if (enqueued) report.orphanDeletesEnqueued += 1;
      } catch (error) {
        report.errors.push({
          objectKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    report.errors.push({
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return report;
}

export async function runRestoreConverge(
  db: DbClient = getDb(),
  options: {
    pageSize?: number;
    maxObjects?: number;
    prefix?: string;
    prefixes?: string | readonly string[];
  } = {},
): Promise<ConvergeReport> {
  const storageConfig = await getStorageConfig();
  const referencedRows = await db
    .select({
      storageDriver: files.storageDriver,
      bucket: files.bucket,
      objectKey: files.objectKey,
    })
    .from(files)
    .orderBy(asc(files.id));

  const drivers = new Set<StorageDriver>([storageConfig.driver]);
  for (const row of referencedRows) {
    drivers.add(row.storageDriver);
  }

  const driverReports: ConvergeDriverReport[] = [];
  for (const driver of drivers) {
    const referenced = referencedRows
      .filter((row) => row.storageDriver === driver)
      .map((row) => ({
        storageDriver: row.storageDriver,
        bucket: row.bucket,
        objectKey: row.objectKey,
      }));
    driverReports.push(
      await convergeDriver({
        db,
        driver,
        storageConfig,
        referenced,
        pageSize: options.pageSize,
        maxObjects: options.maxObjects,
        prefix: options.prefix,
        prefixes: options.prefixes,
      }),
    );
  }

  const report: ConvergeReport = {
    drivers: driverReports,
    totalMissingReferenced: driverReports.reduce(
      (sum, driverReport) => sum + driverReport.missingReferenced,
      0,
    ),
    totalNewlyQuarantined: driverReports.reduce(
      (sum, driverReport) => sum + driverReport.newlyQuarantined,
      0,
    ),
    totalOrphanObjects: driverReports.reduce(
      (sum, driverReport) => sum + driverReport.orphanObjects,
      0,
    ),
    totalOrphanDeletesEnqueued: driverReports.reduce(
      (sum, driverReport) => sum + driverReport.orphanDeletesEnqueued,
      0,
    ),
    totalErrors: driverReports.reduce((sum, driverReport) => sum + driverReport.errors.length, 0),
    truncated: driverReports.some((driverReport) => driverReport.truncated),
  };

  if (report.totalErrors > 0 || report.truncated) {
    throw new RestoreConvergeError(report);
  }

  return report;
}

export class RestoreConvergeError extends Error {
  constructor(readonly report: ConvergeReport) {
    const reasons: string[] = [];
    if (report.totalErrors > 0) {
      reasons.push(`${report.totalErrors} error(s)`);
    }
    if (report.truncated) {
      reasons.push("enumeration truncated before completion");
    }
    super(`restore converge failed: ${reasons.join("; ")}`);
    this.name = "RestoreConvergeError";
  }
}

export function formatConvergeReport(report: ConvergeReport): string {
  return JSON.stringify(report, null, 2);
}

export type { RestoreScanError };
