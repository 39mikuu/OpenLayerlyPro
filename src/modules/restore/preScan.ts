import { asc, eq, sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import { files } from "@/db/schema";
import { FILE_SAFETY_REMEDIATION_VERSION } from "@/modules/file/backfillSafety";

import { objectExists } from "./storageProbe";
import type { PreScanReport, RestoreScanError } from "./types";

const MISSING_AFTER_RESTORE_REASON = "missing after restore";

export async function runRestorePreScan(db: DbClient = getDb()): Promise<PreScanReport> {
  const report: PreScanReport = {
    scanned: 0,
    quarantined: 0,
    errors: [],
  };

  const rows = await db.select().from(files).orderBy(asc(files.id));
  for (const file of rows) {
    report.scanned += 1;
    try {
      const exists = await objectExists({
        driver: file.storageDriver,
        bucket: file.bucket,
        objectKey: file.objectKey,
      });
      if (exists) continue;

      const [updated] = await db
        .update(files)
        .set({
          quarantinedAt: sql`now()`,
          quarantineReason: MISSING_AFTER_RESTORE_REASON,
          remediationVersion: FILE_SAFETY_REMEDIATION_VERSION,
          updatedAt: sql`now()`,
        })
        .where(eq(files.id, file.id))
        .returning({ id: files.id });
      if (updated) report.quarantined += 1;
    } catch (error) {
      report.errors.push({
        fileId: file.id,
        objectKey: file.objectKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (report.errors.length > 0) {
    throw new RestorePreScanError(report);
  }

  return report;
}

export class RestorePreScanError extends Error {
  constructor(readonly report: PreScanReport) {
    super(`restore pre-scan failed with ${report.errors.length} error(s)`);
    this.name = "RestorePreScanError";
  }
}

export function formatPreScanReport(report: PreScanReport): string {
  return JSON.stringify(report, null, 2);
}

export type { RestoreScanError };
