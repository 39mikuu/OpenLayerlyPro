import { afterEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/db/schema";
import { __resetEnvForTests } from "@/lib/env";

import { dispatchClaimedTask, dispatchTaskBatch } from "./dispatcher";
import { PermanentTaskError, TASK_BATCH_SIZE, TASK_LEASE_MS } from "./index";

function task(id: string, lockToken = `claim-${id}`): Task {
  const now = new Date();
  return {
    id,
    kind: "email",
    dedupeKey: null,
    payloadJson: {},
    runAfter: now,
    status: "processing",
    attempts: 1,
    maxAttempts: 5,
    lockedAt: now,
    lockedBy: lockToken,
    leaseUntil: new Date(now.getTime() + 60_000),
    lastError: null,
    priority: 10,
    queueClass: "transactional",
    createdAt: now,
    updatedAt: now,
  };
}

describe("task dispatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function dependencies() {
    return {
      claim: vi.fn(),
      claimClass: vi.fn(),
      run: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      dead: vi.fn(),
      defer: vi.fn(),
      renew: vi.fn().mockResolvedValue(true),
      sweep: vi.fn().mockResolvedValue([]),
    };
  }

  it("claims one task at a time and stops when the queue is empty", async () => {
    const first = task("11111111-1111-4111-8111-111111111111");
    const second = task("22222222-2222-4222-8222-222222222222");
    const deps = dependencies();
    deps.claimClass
      .mockResolvedValueOnce({ ...first, reclaimedStale: false })
      .mockResolvedValueOnce({ ...second, reclaimedStale: false })
      .mockResolvedValue(null);
    deps.run.mockResolvedValue({ note: "SMTP not configured" });
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch(deps)).resolves.toBe(2);
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.claimClass).toHaveBeenCalledTimes(7);
    expect(deps.claimClass).toHaveBeenNthCalledWith(1, "transactional", { includeStale: true });
    expect(deps.claimClass).toHaveBeenNthCalledWith(2, "transactional", { includeStale: true });
    expect(deps.succeed).toHaveBeenNthCalledWith(
      1,
      first.id,
      first.lockedBy,
      "SMTP not configured",
    );
    expect(deps.succeed).toHaveBeenNthCalledWith(
      2,
      second.id,
      second.lockedBy,
      "SMTP not configured",
    );
  });

  it("sweeps expired final-attempt leases once before the first claim", async () => {
    const first = task("11111111-1111-4111-8111-111111111111");
    const second = task("22222222-2222-4222-8222-222222222222");
    const calls: string[] = [];
    const deps = dependencies();
    deps.sweep.mockImplementation(async () => {
      calls.push("sweep");
      return [];
    });
    deps.claimClass.mockImplementation(async () => {
      calls.push("claim");
      if (deps.claimClass.mock.calls.length === 1) return { ...first, reclaimedStale: false };
      if (deps.claimClass.mock.calls.length === 2) return { ...second, reclaimedStale: false };
      return null;
    });
    deps.run.mockImplementation(async (claimed: Task) => {
      calls.push("run:" + claimed.id);
      return {};
    });
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch(deps)).resolves.toBe(2);

    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.claimClass).toHaveBeenCalledTimes(7);
    expect(calls.slice(0, 2)).toEqual(["sweep", "claim"]);
  });

  it("processes at most the configured batch size", async () => {
    const deps = dependencies();
    deps.claimClass.mockImplementation(async () => ({
      ...task(`task-${deps.claimClass.mock.calls.length}`),
      reclaimedStale: false,
    }));
    deps.run.mockResolvedValue({});
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch(deps)).resolves.toBe(TASK_BATCH_SIZE);
    expect(deps.claimClass).toHaveBeenCalledTimes(TASK_BATCH_SIZE);
  });

  it("uses the stale-first transactional/v2 claim group for protocol-v2 delivery", async () => {
    const deps = dependencies();
    const v2Task = {
      ...task("11111111-1111-4111-8111-111111111111"),
      kind: "auth.magic_link_email",
      payloadJson: {
        version: 1,
        deliveryProtocol: 2,
        tokenId: "22222222-2222-4222-8222-222222222222",
        encryptedToken: "encrypted",
      },
      queueClass: "auth_delivery_v2" as const,
      reclaimedStale: true,
    };
    const claimGroup = vi.fn().mockResolvedValueOnce(v2Task).mockResolvedValue(null);
    deps.run.mockResolvedValue({});
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch({ ...deps, claimGroup })).resolves.toBe(1);
    expect(claimGroup).toHaveBeenNthCalledWith(1, ["transactional", "auth_delivery_v2"], {
      includeStale: true,
    });
  });

  it("enforces the auth_intake cap before claiming another public request task", async () => {
    const previousCap = process.env.TASK_AUTH_INTAKE_MAX_PER_BATCH;
    process.env.TASK_AUTH_INTAKE_MAX_PER_BATCH = "1";
    __resetEnvForTests();
    try {
      const deps = dependencies();
      deps.claimClass.mockImplementation(async (queueClass: string) => {
        if (queueClass !== "auth_intake") return null;
        return {
          ...task("11111111-1111-4111-8111-111111111111"),
          kind: "auth.magic_link_request",
          payloadJson: { version: 1, requestId: "22222222-2222-4222-8222-222222222222" },
          queueClass: "auth_intake",
          reclaimedStale: false,
        };
      });
      deps.run.mockResolvedValue({});
      deps.succeed.mockResolvedValue(true);

      await expect(dispatchTaskBatch(deps)).resolves.toBe(1);
      expect(
        deps.claimClass.mock.calls.filter(([queueClass]) => queueClass === "auth_intake"),
      ).toHaveLength(1);
    } finally {
      if (previousCap === undefined) delete process.env.TASK_AUTH_INTAKE_MAX_PER_BATCH;
      else process.env.TASK_AUTH_INTAKE_MAX_PER_BATCH = previousCap;
      __resetEnvForTests();
    }
  });

  it("guarantees default progress when transactional and notification queues stay full", async () => {
    const deps = dependencies();
    const seen: string[] = [];
    const nextTask = (queueClass: "transactional" | "notification" | "default") => ({
      ...task(`${queueClass}-${seen.length}`),
      queueClass,
      reclaimedStale: false,
    });
    deps.claimClass.mockImplementation(async (queueClass: string) => {
      if (queueClass === "maintenance") return null;
      seen.push(queueClass);
      return nextTask(queueClass as "transactional" | "notification" | "default");
    });
    deps.run.mockResolvedValue({});
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch(deps)).resolves.toBe(TASK_BATCH_SIZE);

    expect(seen.filter((queueClass) => queueClass === "transactional")).toHaveLength(16);
    expect(seen.filter((queueClass) => queueClass === "notification")).toHaveLength(2);
    expect(seen.filter((queueClass) => queueClass === "default")).toHaveLength(2);
  });

  it("marks failures with the matching token and continues to the next task", async () => {
    const first = task("11111111-1111-4111-8111-111111111111");
    const second = task("22222222-2222-4222-8222-222222222222");
    const error = new Error("SMTP unavailable");
    const deps = dependencies();
    deps.claimClass
      .mockResolvedValueOnce({ ...first, reclaimedStale: false })
      .mockResolvedValueOnce({ ...second, reclaimedStale: false })
      .mockResolvedValue(null);
    deps.run.mockRejectedValueOnce(error).mockResolvedValueOnce({});
    deps.fail.mockResolvedValue({ updated: true, status: "failed" });
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch(deps)).resolves.toBe(2);
    expect(deps.fail).toHaveBeenCalledWith(first.id, first.lockedBy, error);
    expect(deps.succeed).toHaveBeenCalledWith(second.id, second.lockedBy, undefined);
  });

  it("defers an early task without marking it succeeded or failed", async () => {
    const claimed = task("11111111-1111-4111-8111-111111111111");
    const deferUntil = new Date("2026-06-20T12:00:00.000Z");
    const deps = dependencies();
    deps.run.mockResolvedValue({ note: "not due", deferUntil });
    deps.defer.mockResolvedValue(true);

    await dispatchClaimedTask(claimed, deps);

    expect(deps.defer).toHaveBeenCalledWith(claimed.id, claimed.lockedBy, deferUntil);
    expect(deps.succeed).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("marks permanent handler errors dead without retrying", async () => {
    const claimed = task("11111111-1111-4111-8111-111111111111");
    const error = new PermanentTaskError("Invalid publish_post payload");
    const deps = dependencies();
    deps.run.mockRejectedValue(error);
    deps.dead.mockResolvedValue({ updated: true, status: "dead" });

    await dispatchClaimedTask(claimed, deps);

    expect(deps.dead).toHaveBeenCalledWith(claimed.id, claimed.lockedBy, error);
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("renews long-running work and clears the heartbeat after completion", async () => {
    vi.useFakeTimers();
    const claimed = task("11111111-1111-4111-8111-111111111111");
    const deps = dependencies();
    let finish: ((value: { note?: string }) => void) | undefined;
    deps.run.mockReturnValue(
      new Promise<{ note?: string }>((resolve) => {
        finish = resolve;
      }),
    );
    deps.succeed.mockResolvedValue(true);

    const dispatching = dispatchClaimedTask(claimed, deps);
    await vi.advanceTimersByTimeAsync(TASK_LEASE_MS + Math.floor(TASK_LEASE_MS / 3));
    expect(deps.renew).toHaveBeenCalledTimes(4);
    expect(deps.renew).toHaveBeenCalledWith(claimed.id, claimed.lockedBy);

    finish?.({});
    await dispatching;
    const renewalCount = deps.renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TASK_LEASE_MS);
    expect(deps.renew).toHaveBeenCalledTimes(renewalCount);
  });

  it("does not treat a lost lease as a new handler failure", async () => {
    const claimed = task("11111111-1111-4111-8111-111111111111");
    const deps = dependencies();
    deps.run.mockResolvedValue({});
    deps.succeed.mockResolvedValue(false);

    await dispatchClaimedTask(claimed, deps);

    expect(deps.succeed).toHaveBeenCalledWith(claimed.id, claimed.lockedBy, undefined);
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("aborts ownership and blocks a second side effect after renewal returns false", async () => {
    vi.useFakeTimers();
    const claimed = task("11111111-1111-4111-8111-111111111111");
    const deps = dependencies();
    const effects: string[] = [];
    let resume: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const firstEffectStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    deps.renew.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    deps.run.mockImplementation(async (_task, execution) => {
      await execution.assertOwnership();
      effects.push("first");
      entered?.();
      await paused;
      await execution.assertOwnership();
      effects.push("second");
      return {};
    });

    const dispatching = dispatchClaimedTask(claimed, deps);
    await firstEffectStarted;
    await vi.advanceTimersByTimeAsync(Math.floor(TASK_LEASE_MS / 3));
    resume?.();
    await dispatching;

    expect(effects).toEqual(["first"]);
    expect(deps.succeed).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.dead).not.toHaveBeenCalled();
  });

  it("treats a renewal exception as immediate ownership loss", async () => {
    vi.useFakeTimers();
    const claimed = task("11111111-1111-4111-8111-111111111111");
    const deps = dependencies();
    let executionSignal: AbortSignal | undefined;
    let resume: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    deps.renew.mockRejectedValue(new Error("database connection lost"));
    deps.run.mockImplementation(async (_task, execution) => {
      executionSignal = execution.signal;
      await paused;
      await execution.assertOwnership();
      return {};
    });

    const dispatching = dispatchClaimedTask(claimed, deps);
    await vi.advanceTimersByTimeAsync(Math.floor(TASK_LEASE_MS / 3));
    expect(executionSignal?.aborted).toBe(true);
    resume?.();
    await dispatching;

    expect(deps.succeed).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.dead).not.toHaveBeenCalled();
  });
});
