import { describe, expect, it, vi } from "vitest";

import type { Task } from "@/db/schema";

import { dispatchTaskBatch } from "./dispatcher";

function task(id: string): Task {
  const now = new Date();
  return {
    id,
    kind: "email",
    dedupeKey: null,
    payloadJson: {},
    runAfter: now,
    status: "processing",
    attempts: 0,
    maxAttempts: 5,
    lockedAt: now,
    lockedBy: "worker",
    leaseUntil: new Date(now.getTime() + 60_000),
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("task dispatcher", () => {
  it("marks successful handlers complete, including no-op notes", async () => {
    const first = task("11111111-1111-4111-8111-111111111111");
    const claim = vi.fn().mockResolvedValue([first]);
    const run = vi.fn().mockResolvedValue({ note: "SMTP not configured" });
    const succeed = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(dispatchTaskBatch({ claim, run, succeed, fail })).resolves.toBe(1);
    expect(succeed).toHaveBeenCalledWith(first.id, "SMTP not configured");
    expect(fail).not.toHaveBeenCalled();
  });

  it("records handler failures and continues processing the batch", async () => {
    const first = task("11111111-1111-4111-8111-111111111111");
    const second = task("22222222-2222-4222-8222-222222222222");
    const error = new Error("SMTP unavailable");
    const claim = vi.fn().mockResolvedValue([first, second]);
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({});
    const succeed = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockResolvedValue(undefined);

    await expect(dispatchTaskBatch({ claim, run, succeed, fail })).resolves.toBe(2);
    expect(fail).toHaveBeenCalledWith(first.id, error);
    expect(succeed).toHaveBeenCalledWith(second.id, undefined);
  });
});
