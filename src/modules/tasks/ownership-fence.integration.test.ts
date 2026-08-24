import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { type Task, tasks } from "@/db/schema";
import { getEnv } from "@/lib/env";

import { dispatchClaimedTask } from "./dispatcher";
import {
  claimDueTasks,
  deferTask,
  markTaskDead,
  markTaskFailed,
  markTaskSucceeded,
  sweepExpiredFinalAttemptTasks,
} from "./runtime";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("task ownership side-effect fence", () => {
  const db = getDb();

  beforeEach(async () => {
    await db.delete(tasks);
  });

  it("blocks worker A from starting a second side effect after worker B reclaims its lease", async () => {
    const workerA = postgres(getEnv().DATABASE_URL, { max: 1, onnotice: () => {} });

    try {
      const [aBackend] = await workerA`select pg_backend_pid()::int as pid`;
      const [poolBackend] = await db.execute<{ pid: number }>(
        sql`select pg_backend_pid()::int as pid`,
      );
      expect(aBackend?.pid).not.toBe(poolBackend?.pid);

      const [created] = await db
        .insert(tasks)
        .values({ kind: "storage.delete_object", payloadJson: {}, runAfter: new Date() })
        .returning();
      if (!created) throw new Error("failed to seed task");

      const [claimedByA] = await claimDueTasks(1, {
        lockToken: "worker-a",
        leaseMs: 1_000,
      });
      expect(claimedByA).toMatchObject({
        id: created.id,
        attempts: 1,
        lockedBy: "worker-a",
      });

      const effects: string[] = [];
      let resumeWorkerA: (() => void) | undefined;
      let markFirstEffectStarted: (() => void) | undefined;
      const workerAPaused = new Promise<void>((resolve) => {
        resumeWorkerA = resolve;
      });
      const firstEffectStarted = new Promise<void>((resolve) => {
        markFirstEffectStarted = resolve;
      });

      const dependencies = {
        claim: claimDueTasks,
        run: vi.fn(async (_task: Task, execution) => {
          await execution.assertOwnership();
          effects.push("first");
          markFirstEffectStarted?.();
          await workerAPaused;
          await execution.assertOwnership();
          effects.push("second");
          return {};
        }),
        succeed: vi.fn(markTaskSucceeded),
        fail: vi.fn(markTaskFailed),
        dead: vi.fn(markTaskDead),
        defer: vi.fn(deferTask),
        renew: vi.fn(async (id: string, lockToken: string) => {
          const renewed = await workerA`
            update tasks
            set lease_until = clock_timestamp() + interval '1 second',
                updated_at = clock_timestamp()
            where id = ${id}
              and status = 'processing'
              and locked_by = ${lockToken}
              and lease_until > clock_timestamp()
            returning id
          `;
          return renewed.length === 1;
        }),
        sweep: vi.fn(sweepExpiredFinalAttemptTasks),
      };

      const dispatching = dispatchClaimedTask(claimedByA!, dependencies);
      await firstEffectStarted;

      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const [claimedByB] = await claimDueTasks(1, {
        lockToken: "worker-b",
        leaseMs: 60_000,
      });
      expect(claimedByB).toMatchObject({ id: created.id, attempts: 2, lockedBy: "worker-b" });

      resumeWorkerA?.();
      await dispatching;

      expect(effects).toEqual(["first"]);
      expect(dependencies.succeed).not.toHaveBeenCalled();
      expect(dependencies.fail).not.toHaveBeenCalled();
      expect(dependencies.dead).not.toHaveBeenCalled();
      expect(dependencies.defer).not.toHaveBeenCalled();
      const [stored] = await db.select().from(tasks).where(eq(tasks.id, created.id));
      expect(stored).toMatchObject({ status: "processing", attempts: 2, lockedBy: "worker-b" });
    } finally {
      await workerA.end({ timeout: 1 });
    }
  });
});
