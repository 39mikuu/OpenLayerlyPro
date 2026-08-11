import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { maintainMagicLinkDeliveryState } from "@/modules/auth/magic-link-maintenance";
import {
  claimDueTasks,
  claimOneTaskForClass,
  claimOneTaskForClasses,
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
import { type TaskExecutionContext, TaskOwnershipLostError } from "@/modules/tasks/ownership";

type DispatcherDependencies = {
  claim: typeof claimDueTasks;
  claimClass?: typeof claimOneTaskForClass;
  claimGroup?: typeof claimOneTaskForClasses;
  run: typeof runTaskHandler;
  succeed: typeof markTaskSucceeded;
  fail: typeof markTaskFailed;
  dead: typeof markTaskDead;
  defer: typeof deferTask;
  renew: typeof renewTaskLease;
  sweep: typeof sweepExpiredFinalAttemptTasks;
  maintainMagicLinkDelivery?: typeof maintainMagicLinkDeliveryState;
};

const defaultDependencies: DispatcherDependencies = {
  claim: claimDueTasks,
  claimClass: claimOneTaskForClass,
  claimGroup: claimOneTaskForClasses,
  run: runTaskHandler,
  succeed: markTaskSucceeded,
  fail: markTaskFailed,
  dead: markTaskDead,
  defer: deferTask,
  renew: renewTaskLease,
  sweep: sweepExpiredFinalAttemptTasks,
  maintainMagicLinkDelivery: maintainMagicLinkDeliveryState,
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
  let stopped = false;
  let renewalInFlight: Promise<boolean> | null = null;
  const abortController = new AbortController();
  const loseOwnership = (message: string, error?: unknown) => {
    if (leaseLost || stopped) return;
    leaseLost = true;
    abortController.abort(new TaskOwnershipLostError());
    if (error === undefined) {
      logger.warn(message, { taskId: task.id });
      return;
    }
    logger.error(message, {
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error),
    });
  };
  const renewOwnership = (): Promise<boolean> => {
    if (leaseLost || stopped) return Promise.resolve(false);
    if (renewalInFlight) return renewalInFlight;
    renewalInFlight = (async () => {
      try {
        const renewed = await dependencies.renew(task.id, lockToken);
        if (!renewed) loseOwnership("Task lease was lost during execution");
        return renewed;
      } catch (error) {
        loseOwnership("Task lease renewal failed", error);
        return false;
      } finally {
        renewalInFlight = null;
      }
    })();
    return renewalInFlight;
  };
  const execution: TaskExecutionContext = {
    signal: abortController.signal,
    ownershipLost: () => leaseLost,
    assertOwnership: async () => {
      if (leaseLost || abortController.signal.aborted || !(await renewOwnership())) {
        throw new TaskOwnershipLostError();
      }
    },
  };
  const heartbeat = setInterval(
    () => {
      void renewOwnership();
    },
    Math.floor(TASK_LEASE_MS / 3),
  );
  heartbeat.unref();

  try {
    let result;
    try {
      result = await dependencies.run(task, execution);
    } catch (error) {
      if (leaseLost || error instanceof TaskOwnershipLostError) return;
      try {
        await execution.assertOwnership();
      } catch (ownershipError) {
        if (ownershipError instanceof TaskOwnershipLostError) return;
        throw ownershipError;
      }
      const failure =
        error instanceof PermanentTaskError
          ? await dependencies.dead(task.id, lockToken, error)
          : await dependencies.fail(task.id, lockToken, error);
      if (!failure.updated) {
        loseOwnership("Task failure ignored because the lease was lost");
      }
      return;
    }

    await execution.assertOwnership();
    const completed = result.deferUntil
      ? await dependencies.defer(task.id, lockToken, result.deferUntil)
      : await dependencies.succeed(task.id, lockToken, result.note);
    if (!completed) loseOwnership("Task completion ignored because the lease was lost");
  } catch (error) {
    if (error instanceof TaskOwnershipLostError) return;
    throw error;
  } finally {
    stopped = true;
    clearInterval(heartbeat);
  }
}

export async function dispatchTaskBatch(
  dependencies: DispatcherDependencies = defaultDependencies,
): Promise<number> {
  await dependencies.sweep();
  await dependencies.maintainMagicLinkDelivery?.();

  const env = getEnv();
  const claimOneForClass = dependencies.claimClass ?? claimOneTaskForClass;
  let processed = 0;
  let transactionalClaimed = 0;
  let notificationClaimed = 0;
  let defaultClaimed = 0;
  let notificationStaleClaimed = 0;
  let maintenanceClaimed = 0;
  let authIntakeClaimed = 0;

  const claimClass = async (queueClass: TaskQueueClass) => {
    if (queueClass === "maintenance" && maintenanceClaimed >= env.TASK_MAINTENANCE_MAX_PER_BATCH) {
      return null;
    }
    if (queueClass === "auth_intake" && authIntakeClaimed >= env.TASK_AUTH_INTAKE_MAX_PER_BATCH) {
      return null;
    }
    const includeStale =
      queueClass !== "notification" ||
      notificationStaleClaimed < env.TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH;
    const task =
      queueClass === "transactional" && dependencies.claimGroup
        ? await dependencies.claimGroup(["transactional", "auth_delivery_v2"], { includeStale })
        : await claimOneForClass(queueClass, { includeStale });
    if (!task) return null;
    if (task.queueClass === "transactional" || task.queueClass === "auth_delivery_v2") {
      transactionalClaimed += 1;
    }
    if (task.queueClass === "default") defaultClaimed += 1;
    if (task.queueClass === "notification") {
      notificationClaimed += 1;
      if (task.reclaimedStale) notificationStaleClaimed += 1;
    }
    if (task.queueClass === "maintenance") maintenanceClaimed += 1;
    if (task.queueClass === "auth_intake") authIntakeClaimed += 1;
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
    const notificationDeficit = env.TASK_NOTIFICATION_MIN_PER_BATCH - notificationClaimed;
    const defaultDeficit = env.TASK_DEFAULT_MIN_PER_BATCH - defaultClaimed;
    const notificationSlotsAtRisk = remainingSlots <= Math.max(notificationDeficit, 0);
    const defaultSlotsAtRisk = remainingSlots <= Math.max(defaultDeficit, 0);
    const reservedSlotsAtRisk =
      remainingSlots <= Math.max(notificationDeficit, 0) + Math.max(defaultDeficit, 0);
    const task =
      defaultSlotsAtRisk && defaultDeficit > 0
        ? await claimByOrder(["default", "notification", "maintenance"])
        : notificationSlotsAtRisk && notificationDeficit > 0
          ? await claimByOrder(["notification", "default", "maintenance"])
          : reservedSlotsAtRisk && defaultDeficit > 0
            ? await claimByOrder(["default", "notification", "maintenance"])
            : reservedSlotsAtRisk && notificationDeficit > 0
              ? await claimByOrder(["notification", "default", "maintenance"])
              : transactionalClaimed < env.TASK_TRANSACTIONAL_RESERVED_PER_BATCH
                ? await claimByOrder([
                    "transactional",
                    "notification",
                    "default",
                    "maintenance",
                    "auth_intake",
                  ])
                : notificationDeficit > 0
                  ? await claimByOrder([
                      "notification",
                      "transactional",
                      "default",
                      "maintenance",
                      "auth_intake",
                    ])
                  : defaultDeficit > 0
                    ? await claimByOrder([
                        "default",
                        "transactional",
                        "notification",
                        "maintenance",
                        "auth_intake",
                      ])
                    : await claimByOrder([
                        "transactional",
                        "default",
                        "notification",
                        "maintenance",
                        "auth_intake",
                      ]);
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
