import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db";

import { getTaskQueueOperationalSnapshot } from "./operational-snapshot";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("task queue operational snapshot", () => {
  it("classifies queue, lease, exhaustion, and fence states without exposing task data", async () => {
    const rollback = new Error("rollback task queue operational snapshot test");

    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(sql`delete from tasks`);
        await tx.execute(sql`
          insert into tasks (
            kind, payload_json, queue_class, status, attempts, max_attempts,
            run_after, locked_at, locked_by, lease_until
          ) values
            ('test.due', '{}', 'transactional', 'pending', 0, 5,
              clock_timestamp() - interval '2 hours', null, null, null),
            ('test.scheduled', '{}', 'transactional', 'failed', 1, 5,
              clock_timestamp() + interval '2 hours', null, null, null),
            ('test.active', '{}', 'notification', 'processing', 1, 5,
              clock_timestamp(), clock_timestamp(), 'active-claim',
              clock_timestamp() + interval '2 minutes'),
            ('test.active-final', '{}', 'notification', 'processing', 5, 5,
              clock_timestamp(), clock_timestamp(), 'active-final-claim',
              clock_timestamp() + interval '2 minutes'),
            ('test.stale', '{}', 'notification', 'processing', 1, 5,
              clock_timestamp(), clock_timestamp() - interval '2 minutes', 'stale-claim',
              clock_timestamp() - interval '1 minute'),
            ('test.stale-missing-fence', '{}', 'notification', 'processing', 1, 5,
              clock_timestamp(), null, null, clock_timestamp() - interval '1 minute'),
            ('test.exhausted-processing', '{}', 'maintenance', 'processing', 5, 5,
              clock_timestamp(), clock_timestamp() - interval '2 minutes', 'exhausted-claim',
              clock_timestamp() - interval '1 minute'),
            ('test.exhausted-waiting', '{}', 'maintenance', 'failed', 5, 5,
              clock_timestamp() - interval '1 minute', null, null, null),
            ('test.dead', '{}', 'default', 'dead', 5, 5,
              clock_timestamp(), null, null, null),
            ('test.invalid-processing-fence', '{}', 'default', 'processing', 1, 5,
              clock_timestamp(), null, null, null),
            ('test.leaked-fence', '{}', 'default', 'succeeded', 1, 5,
              clock_timestamp(), clock_timestamp(), 'leaked-claim',
              clock_timestamp() + interval '1 minute')
        `);

        const snapshot = await getTaskQueueOperationalSnapshot(tx);
        const transactional = snapshot.queues.find((queue) => queue.queueClass === "transactional");
        const notification = snapshot.queues.find((queue) => queue.queueClass === "notification");
        const maintenance = snapshot.queues.find((queue) => queue.queueClass === "maintenance");
        const defaultQueue = snapshot.queues.find((queue) => queue.queueClass === "default");

        expect(transactional).toMatchObject({ due: 1, scheduled: 1 });
        expect(transactional?.oldestDueAt).not.toBeNull();
        expect(notification).toMatchObject({
          activeLeases: 2,
          staleLeases: 2,
          fenceAnomalies: 1,
        });
        expect(maintenance).toMatchObject({ exhausted: 1, stranded: 1 });
        expect(defaultQueue).toMatchObject({ dead: 1, fenceAnomalies: 2 });
        expect(snapshot.totals).toMatchObject({
          due: 1,
          scheduled: 1,
          activeLeases: 2,
          staleLeases: 2,
          exhausted: 1,
          stranded: 1,
          dead: 1,
          fenceAnomalies: 3,
        });
        expect(snapshot).not.toHaveProperty("payloadJson");
        expect(snapshot).not.toHaveProperty("lockedBy");
        expect(JSON.stringify(snapshot)).not.toContain("active-claim");
        expect(JSON.stringify(snapshot)).not.toContain("test.due");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
