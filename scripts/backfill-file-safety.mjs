import { runFileSafetyBackfill } from "@/modules/file/backfillSafety";

const apply = process.argv.includes("--apply");
const batchArg = process.argv.find((arg) => arg.startsWith("--batch-size="));
const batchSize = batchArg ? Number(batchArg.split("=", 2)[1]) : 100;

if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
  throw new Error("--batch-size must be an integer between 1 and 1000");
}

const result = await runFileSafetyBackfill({
  apply,
  batchSize,
  onProgress: (message) => console.log(message),
});

console.log(JSON.stringify(result, null, 2));
if (!apply) {
  console.log("Dry-run only. Re-run with --apply to persist changes.");
}
