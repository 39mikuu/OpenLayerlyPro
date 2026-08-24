import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/db";

import { getTaskQueueOperationalSnapshot } from "./operational-snapshot";
import { TASK_QUEUE_CLASSES } from "./queue-class";

describe("getTaskQueueOperationalSnapshot", () => {
  it("maps every queue class and derives safe aggregate totals", async () => {
    const capturedAt = "2026-08-24T12:00:00.000Z";
    const execute = vi.fn().mockResolvedValue(
      TASK_QUEUE_CLASSES.map((queueClass, index) => ({
        queue_class: queueClass,
        captured_at: capturedAt,
        due: index,
        scheduled: index === 0 ? "2" : 0,
        active_leases: index === 1 ? 1 : 0,
        stale_leases: index === 2 ? 1 : 0,
        exhausted: index === 3 ? 1 : 0,
        stranded: index === 4 ? 1 : 0,
        dead: index === 4 ? 1 : 0,
        fence_anomalies: index === 5 ? 1 : 0,
        oldest_due_at:
          index === 1
            ? "2026-08-24T10:00:00.000Z"
            : index === 2
              ? "2026-08-24T09:00:00.000Z"
              : null,
      })),
    );

    const result = await getTaskQueueOperationalSnapshot({ execute } as unknown as DbClient);

    expect(result.capturedAt).toEqual(new Date(capturedAt));
    expect(result.queues.map((queue) => queue.queueClass)).toEqual(TASK_QUEUE_CLASSES);
    expect(Object.keys(result.queues[0]!)).toEqual([
      "queueClass",
      "due",
      "scheduled",
      "activeLeases",
      "staleLeases",
      "exhausted",
      "stranded",
      "dead",
      "fenceAnomalies",
      "oldestDueAt",
    ]);
    expect(result.totals).toEqual({
      due: 15,
      scheduled: 2,
      activeLeases: 1,
      staleLeases: 1,
      exhausted: 1,
      stranded: 1,
      dead: 1,
      fenceAnomalies: 1,
      oldestDueAt: new Date("2026-08-24T09:00:00.000Z"),
    });
  });

  it("rejects incomplete or reordered queue-class results", async () => {
    const rows = TASK_QUEUE_CLASSES.map((queueClass) => ({
      queue_class: queueClass,
      captured_at: "2026-08-24T12:00:00.000Z",
      due: 0,
      scheduled: 0,
      active_leases: 0,
      stale_leases: 0,
      exhausted: 0,
      stranded: 0,
      dead: 0,
      fence_anomalies: 0,
      oldest_due_at: null,
    }));
    const incompleteDb = {
      execute: vi.fn().mockResolvedValue(rows.slice(1)),
    } as unknown as DbClient;
    const reorderedDb = {
      execute: vi.fn().mockResolvedValue(rows.toSpliced(0, 2, rows[1]!, rows[0]!)),
    } as unknown as DbClient;

    await expect(getTaskQueueOperationalSnapshot(incompleteDb)).rejects.toThrow(
      "did not return every queue class",
    );
    await expect(getTaskQueueOperationalSnapshot(reorderedDb)).rejects.toThrow(
      "unexpected queue class",
    );
  });
});
