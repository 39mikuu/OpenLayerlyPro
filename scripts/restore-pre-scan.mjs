import { closeDb } from "@/db";
import {
  formatPreScanReport,
  RestorePreScanError,
  runRestorePreScan,
} from "@/modules/restore/preScan";

try {
  const report = await runRestorePreScan();
  console.log(formatPreScanReport(report));
} catch (error) {
  if (error instanceof RestorePreScanError) {
    console.error(formatPreScanReport(error.report));
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
