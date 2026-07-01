import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { tasks } from "@/db/schema";

import { claimDueTasks } from "./index";

/**
 * Issue #101 — task claim throughput / latency benchmark (evidence only).
 *
 * Gated behind RUN_TASK_BENCHMARK=true so it never runs in normal CI. It seeds a
 * realistic 100k mixed-state task table and measures the cost of the production
 * claim path (`claimDueTasks`, which runs the per-transaction final-attempt sweep
 * followed by the OR claim SELECT with FOR UPDATE SKIP LOCKED).
 *
 * No production code is changed. Captured numbers are recorded in
 * docs/audit/issue-101-dispatcher-design.md.
 */

const runBenchmark = process.env.RUN_TASK_BENCHMARK === "true" ? describe : describe.skip;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

runBenchmark("issue #101 task claim benchmark", () => {
  const db = getDb();

  beforeAll(async () => {
    await db.execute(sql`truncate table ${tasks}`);
    await db.execute(sql`
      insert into tasks (kind, payload_json, run_after, status, attempts, max_attempts)
      select 'email','{}'::jsonb, now() - interval '1 minute', 'pending', 0, 5 from generate_series(1,30000);`);
    await db.execute(sql`
      insert into tasks (kind, payload_json, run_after, status, attempts, max_attempts)
      select 'email','{}'::jsonb, now() + interval '1 hour', 'pending', 0, 5 from generate_series(1,20000);`);
    await db.execute(sql`
      insert into tasks (kind, payload_json, run_after, status, attempts, max_attempts)
      select 'email','{}'::jsonb, now() - interval '30 seconds', 'failed', (1+floor(random()*3))::int, 5 from generate_series(1,15000);`);
    await db.execute(sql`
      insert into tasks (kind, payload_json, run_after, status, attempts, max_attempts, lease_until, locked_by)
      select 'email','{}'::jsonb, now() - interval '5 seconds', 'processing', 1, 5, now() + interval '50 seconds', 'w-fresh' from generate_series(1,10000);`);
    await db.execute(sql`
      insert into tasks (kind, payload_json, run_after, status, attempts, max_attempts, lease_until, locked_by)
      select 'email','{}'::jsonb, now() - interval '5 minutes', 'processing', 2, 5, now() - interval '10 seconds', 'w-stale' from generate_series(1,5000);`);
    await db.execute(sql`
      insert into tasks (kind, payload_json, run_after, status, attempts, max_attempts, lease_until, locked_by)
      select 'email','{}'::jsonb, now() - interval '5 minutes', 'processing', 5, 5, now() - interval '10 seconds', 'w-final' from generate_series(1,2000);`);
    await db.execute(sql`
      insert into tasks (kind, payload_json, run_after, status, attempts, max_attempts)
      select 'email','{}'::jsonb, now() - interval '1 day', 'succeeded', 1, 5 from generate_series(1,15000);`);
    await db.execute(sql`
      insert into tasks (kind, payload_json, run_after, status, attempts, max_attempts)
      select 'email','{}'::jsonb, now() - interval '1 day', 'dead', 5, 5 from generate_series(1,3000);`);
    await db.execute(sql`analyze tasks`);
  }, 120_000);

  afterAll(async () => {
    await db.execute(sql`truncate table ${tasks}`);
  });

  it("measures sequential claim(1) latency (mirrors dispatchTaskBatch)", async () => {
    const iterations = 200;
    const latencies: number[] = [];
    let claimed = 0;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      const rows = await claimDueTasks(1);
      latencies.push(performance.now() - t0);
      claimed += rows.length;
    }
    const wall = performance.now() - start;
    latencies.sort((a, b) => a - b);

    console.log(
      `[bench] claim(1) x${iterations} @100k rows: claimed=${claimed} wall=${wall.toFixed(0)}ms ` +
        `p50=${percentile(latencies, 50).toFixed(2)}ms p95=${percentile(latencies, 95).toFixed(2)}ms ` +
        `claims/s=${((claimed / wall) * 1000).toFixed(0)}`,
    );
    expect(claimed).toBeGreaterThan(0);
  }, 120_000);

  it("measures claim(20) batch latency", async () => {
    const iterations = 50;
    const latencies: number[] = [];
    let claimed = 0;
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      const rows = await claimDueTasks(20);
      latencies.push(performance.now() - t0);
      claimed += rows.length;
    }
    latencies.sort((a, b) => a - b);

    console.log(
      `[bench] claim(20) x${iterations} @100k rows: claimed=${claimed} ` +
        `p50=${percentile(latencies, 50).toFixed(2)}ms p95=${percentile(latencies, 95).toFixed(2)}ms`,
    );
    expect(claimed).toBeGreaterThan(0);
  }, 120_000);

  it("measures 4 concurrent claim(20) workers (SKIP LOCKED contention)", async () => {
    const perWorker = 25;
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: 4 }, async () => {
        let claimed = 0;
        for (let i = 0; i < perWorker; i += 1) {
          claimed += (await claimDueTasks(20)).length;
        }
        return claimed;
      }),
    );
    const wall = performance.now() - start;
    const total = results.reduce((a, b) => a + b, 0);

    console.log(
      `[bench] 4x concurrent claim(20)x${perWorker}: total=${total} wall=${wall.toFixed(0)}ms ` +
        `claims/s=${((total / wall) * 1000).toFixed(0)} per-worker=${results.join("/")}`,
    );
    expect(total).toBeGreaterThan(0);
  }, 120_000);

  it("measures claim cost when nothing is due (pure sweep + empty select overhead)", async () => {
    // Drain everything currently due, then measure the idle claim cost.
    let drained = 0;
    for (;;) {
      const rows = await claimDueTasks(50);
      drained += rows.length;
      if (rows.length === 0) break;
    }
    const iterations = 50;
    const latencies: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      await claimDueTasks(1);
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);

    console.log(
      `[bench] idle claim(1) x${iterations} (drained=${drained}): ` +
        `p50=${percentile(latencies, 50).toFixed(2)}ms p95=${percentile(latencies, 95).toFixed(2)}ms`,
    );
    expect(latencies.length).toBe(iterations);
  }, 120_000);
});
