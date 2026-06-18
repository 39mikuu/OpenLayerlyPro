import { logger } from "@/lib/logger";
import {
  claimDueTasks,
  markTaskFailed,
  markTaskSucceeded,
  TASK_BATCH_SIZE,
  TASK_POLL_INTERVAL_MS,
} from "@/modules/tasks";
import { runTaskHandler } from "@/modules/tasks/handlers";

type DispatcherDependencies = {
  claim: typeof claimDueTasks;
  run: typeof runTaskHandler;
  succeed: typeof markTaskSucceeded;
  fail: typeof markTaskFailed;
};

const defaultDependencies: DispatcherDependencies = {
  claim: claimDueTasks,
  run: runTaskHandler,
  succeed: markTaskSucceeded,
  fail: markTaskFailed,
};

export async function dispatchTaskBatch(
  dependencies: DispatcherDependencies = defaultDependencies,
): Promise<number> {
  const due = await dependencies.claim(TASK_BATCH_SIZE);
  for (const task of due) {
    try {
      const result = await dependencies.run(task);
      await dependencies.succeed(task.id, result.note);
    } catch (error) {
      await dependencies.fail(task.id, error);
    }
  }
  return due.length;
}

let started = false;
let running = false;

export function startTaskDispatcher(): void {
  if (started) return;
  started = true;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchTaskBatch();
    } catch (error) {
      logger.error("Task dispatcher tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(tick, TASK_POLL_INTERVAL_MS);
  timer.unref();
}
