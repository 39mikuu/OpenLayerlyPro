import { logger } from "@/lib/logger";
import {
  claimDueTasks,
  deferTask,
  markTaskDead,
  markTaskFailed,
  markTaskSucceeded,
  renewTaskLease,
  TASK_BATCH_SIZE,
  TASK_LEASE_MS,
  TASK_POLL_INTERVAL_MS,
} from "@/modules/tasks";
import { PermanentTaskError } from "@/modules/tasks/errors";
import { runTaskHandler } from "@/modules/tasks/handlers";

type DispatcherDependencies = {
  claim: typeof claimDueTasks;
  run: typeof runTaskHandler;
  succeed: typeof markTaskSucceeded;
  fail: typeof markTaskFailed;
  dead: typeof markTaskDead;
  defer: typeof deferTask;
  renew: typeof renewTaskLease;
};

const defaultDependencies: DispatcherDependencies = {
  claim: claimDueTasks,
  run: runTaskHandler,
  succeed: markTaskSucceeded,
  fail: markTaskFailed,
  dead: markTaskDead,
  defer: deferTask,
  renew: renewTaskLease,
};

export async function dispatchClaimedTask(
  task: Awaited<ReturnType<typeof claimDueTasks>>[number],
  dependencies: DispatcherDependencies = defaultDependencies,
): Promise<void> {
  const lockToken = task.lockedBy;
  if (!lockToken) {
    logger.warn("Claimed task is missing its lock token", { taskId: task.id });
    return;
  }

  let leaseLost = false;
  const heartbeat = setInterval(
    async () => {
      try {
        const renewed = await dependencies.renew(task.id, lockToken);
        if (!renewed && !leaseLost) {
          leaseLost = true;
          logger.warn("Task lease was lost during execution", { taskId: task.id });
        }
      } catch (error) {
        logger.error("Task lease renewal failed", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    Math.floor(TASK_LEASE_MS / 3),
  );
  heartbeat.unref();

  try {
    const result = await dependencies.run(task);
    const completed = result.deferUntil
      ? await dependencies.defer(task.id, lockToken, result.deferUntil)
      : await dependencies.succeed(task.id, lockToken, result.note);
    if (!completed && !leaseLost) {
      logger.warn("Task completion ignored because the lease was lost", { taskId: task.id });
    }
  } catch (error) {
    const failed =
      error instanceof PermanentTaskError
        ? await dependencies.dead(task.id, lockToken, error)
        : await dependencies.fail(task.id, lockToken, error);
    if (!failed && !leaseLost) {
      logger.warn("Task failure ignored because the lease was lost", { taskId: task.id });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export async function dispatchTaskBatch(
  dependencies: DispatcherDependencies = defaultDependencies,
): Promise<number> {
  let processed = 0;
  for (; processed < TASK_BATCH_SIZE; processed += 1) {
    const [task] = await dependencies.claim(1);
    if (!task) break;
    await dispatchClaimedTask(task, dependencies);
  }
  return processed;
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
