import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  claimDueTasks,
  claimOneTaskForClass,
  deferTask,
  markTaskDead,
  markTaskFailed,
  markTaskSucceeded,
  renewTaskLease,
  sweepExpiredFinalAttemptTasks,
  TASK_BATCH_SIZE,
  TASK_LEASE_MS,
  TASK_POLL_INTERVAL_MS,
  type TaskQueueClass,
} from "@/modules/tasks";
import { PermanentTaskError } from "@/modules/tasks/errors";
import { runTaskHandler } from "@/modules/tasks/handlers";

type DispatcherDependencies = {
  claim: typeof claimDueTasks;
  claimClass?: typeof claimOneTaskForClass;
  run: typeof runTaskHandler;
  succeed: typeof markTaskSucceeded;
  fail: typeof markTaskFailed;
  dead: typeof markTaskDead;
  defer: typeof deferTask;
  renew: typeof renewTaskLease;
  sweep: typeof sweepExpiredFinalAttemptTasks;
};

const defaultDependencies: DispatcherDependencies = {
  claim: claimDueTasks,
  claimClass: claimOneTaskForClass,
  run: runTaskHandler,
  succeed: markTaskSucceeded,
  fail: markTaskFailed,
  dead: markTaskDead,
  defer: deferTask,
  renew: renewTaskLease,
  sweep: sweepExpiredFinalAttemptTasks,
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
    const failure =
      error instanceof PermanentTaskError
        ? await dependencies.dead(task.id, lockToken, error)
        : await dependencies.fail(task.id, lockToken, error);
    if (!failure.updated && !leaseLost) {
      logger.warn("Task failure ignored because the lease was lost", { taskId: task.id });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export async function dispatchTaskBatch(
  dependencies: DispatcherDependencies = defaultDependencies,
): Promise<number> {
  await dependencies.sweep();

  const env = getEnv();
  const claimOneForClass = dependencies.claimClass ?? claimOneTaskForClass;
  let processed = 0;
  let transactionalClaimed = 0;
  let notificationClaimed = 0;
  let notificationStaleClaimed = 0;
  let maintenanceClaimed = 0;

  const claimClass = async (queueClass: TaskQueueClass) => {
    if (queueClass === "maintenance" && maintenanceClaimed >= env.TASK_MAINTENANCE_MAX_PER_BATCH) {
      return null;
    }
    const includeStale =
      queueClass !== "notification" ||
      notificationStaleClaimed < env.TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH;
    const task = await claimOneForClass(queueClass, { includeStale });
    if (!task) return null;
    if (queueClass === "transactional") transactionalClaimed += 1;
    if (queueClass === "notification") {
      notificationClaimed += 1;
      if (task.reclaimedStale) notificationStaleClaimed += 1;
    }
    if (queueClass === "maintenance") maintenanceClaimed += 1;
    return task;
  };

  const claimByOrder = async (order: TaskQueueClass[]) => {
    for (const queueClass of order) {
      const task = await claimClass(queueClass);
      if (task) return task;
    }
    return null;
  };

  for (; processed < TASK_BATCH_SIZE; processed += 1) {
    const remainingSlots = TASK_BATCH_SIZE - processed;
    const task =
      remainingSlots <= env.TASK_NOTIFICATION_MIN_PER_BATCH - notificationClaimed
        ? await claimByOrder(["notification", "transactional", "default", "maintenance"])
        : transactionalClaimed < env.TASK_TRANSACTIONAL_RESERVED_PER_BATCH
          ? await claimByOrder(["transactional", "notification", "default", "maintenance"])
          : notificationClaimed < env.TASK_NOTIFICATION_MIN_PER_BATCH
            ? await claimByOrder(["notification", "transactional", "default", "maintenance"])
            : await claimByOrder(["transactional", "default", "notification", "maintenance"]);
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
