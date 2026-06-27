import { closeDb } from "@/db";
import {
  formatConvergeReport,
  RestoreConvergeError,
  runRestoreConverge,
} from "@/modules/restore/converge";

function readArg(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const pageSize = Number(readArg("page-size"));
const maxObjects = Number(readArg("max-objects"));
const prefix = readArg("prefix");

try {
  const report = await runRestoreConverge(undefined, {
    ...(Number.isInteger(pageSize) && pageSize > 0 ? { pageSize } : {}),
    ...(Number.isInteger(maxObjects) && maxObjects > 0 ? { maxObjects } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
  });
  console.log(formatConvergeReport(report));
} catch (error) {
  if (error instanceof RestoreConvergeError) {
    console.error(formatConvergeReport(error.report));
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
