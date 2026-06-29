import { closeDb } from "@/db";
import { formatNeutralizeReport, neutralizeRestoredTasks } from "@/modules/restore/neutralize";

try {
  const report = await neutralizeRestoredTasks();
  console.log(formatNeutralizeReport(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
