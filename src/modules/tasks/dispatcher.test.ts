import { afterEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/db/schema";

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
    deps.claim
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second])
      .mockResolvedValueOnce([]);
    deps.run.mockResolvedValue({ note: "SMTP not configured" });
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch(deps)).resolves.toBe(2);
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.claim).toHaveBeenCalledTimes(3);
    expect(deps.claim).toHaveBeenNthCalledWith(1, 1);
    expect(deps.claim).toHaveBeenNthCalledWith(2, 1);
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
    deps.claim.mockImplementation(async () => {
      calls.push("claim");
      if (deps.claim.mock.calls.length === 1) return [first];
      if (deps.claim.mock.calls.length === 2) return [second];
      return [];
    });
    deps.run.mockImplementation(async (claimed: Task) => {
      calls.push("run:" + claimed.id);
      return {};
    });
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch(deps)).resolves.toBe(2);

    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.claim).toHaveBeenCalledTimes(3);
    expect(calls.slice(0, 2)).toEqual(["sweep", "claim"]);
  });

  it("processes at most the configured batch size", async () => {
    const deps = dependencies();
    deps.claim.mockImplementation(async () => [task(`task-${deps.claim.mock.calls.length}`)]);
    deps.run.mockResolvedValue({});
    deps.succeed.mockResolvedValue(true);

    await expect(dispatchTaskBatch(deps)).resolves.toBe(TASK_BATCH_SIZE);
    expect(deps.claim).toHaveBeenCalledTimes(TASK_BATCH_SIZE);
    expect(deps.claim).toHaveBeenCalledWith(1);
  });

  it("marks failures with the matching token and continues to the next task", async () => {
    const first = task("11111111-1111-4111-8111-111111111111");
    const second = task("22222222-2222-4222-8222-222222222222");
    const error = new Error("SMTP unavailable");
    const deps = dependencies();
    deps.claim
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second])
      .mockResolvedValueOnce([]);
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
});
