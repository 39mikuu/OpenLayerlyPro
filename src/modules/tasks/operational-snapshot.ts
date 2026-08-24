import { sql } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";

import { isTaskQueueClass, TASK_QUEUE_CLASSES, type TaskQueueClass } from "./queue-class";

export type TaskQueueOperationalCounts = {
  due: number;
  scheduled: number;
  activeLeases: number;
  staleLeases: number;
  exhausted: number;
  stranded: number;
  dead: number;
  fenceAnomalies: number;
  oldestDueAt: Date | null;
};

export type TaskQueueOperationalSnapshot = {
  capturedAt: Date;
  totals: TaskQueueOperationalCounts;
  queues: Array<TaskQueueOperationalCounts & { queueClass: TaskQueueClass }>;
};

type RawSnapshotRow = {
  queue_class: string;
  captured_at: Date | string;
  due: number | string;
  scheduled: number | string;
  active_leases: number | string;
  stale_leases: number | string;
  exhausted: number | string;
  stranded: number | string;
  dead: number | string;
  fence_anomalies: number | string;
  oldest_due_at: Date | string | null;
};

function parseTimestamp(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Task queue snapshot returned an invalid ${field}`);
  }
  return parsed;
}

function addCounts(
  total: TaskQueueOperationalCounts,
  counts: TaskQueueOperationalCounts,
): TaskQueueOperationalCounts {
  return {
    due: total.due + counts.due,
    scheduled: total.scheduled + counts.scheduled,
    activeLeases: total.activeLeases + counts.activeLeases,
    staleLeases: total.staleLeases + counts.staleLeases,
    exhausted: total.exhausted + counts.exhausted,
    stranded: total.stranded + counts.stranded,
    dead: total.dead + counts.dead,
    fenceAnomalies: total.fenceAnomalies + counts.fenceAnomalies,
    oldestDueAt:
      total.oldestDueAt === null ||
      (counts.oldestDueAt !== null && counts.oldestDueAt < total.oldestDueAt)
        ? counts.oldestDueAt
        : total.oldestDueAt,
  };
}

const EMPTY_COUNTS: TaskQueueOperationalCounts = {
  due: 0,
  scheduled: 0,
  activeLeases: 0,
  staleLeases: 0,
  exhausted: 0,
  stranded: 0,
  dead: 0,
  fenceAnomalies: 0,
  oldestDueAt: null,
};

/**
 * Coarse aggregate for operators. It intentionally excludes task IDs, kinds,
 * payloads, errors, and lock tokens.
 */
export async function getTaskQueueOperationalSnapshot(
  db: DbClient = getDb(),
): Promise<TaskQueueOperationalSnapshot> {
  const queueClassValues = sql.join(
    TASK_QUEUE_CLASSES.map((queueClass, index) => sql`(${queueClass}::text, ${index}::integer)`),
    sql`, `,
  );
  const rows = await db.execute<RawSnapshotRow>(sql`
    with snapshot_clock as (
      select clock_timestamp() as captured_at
    ), queue_classes(queue_class, sort_order) as (
      values ${queueClassValues}
    )
    select
      queue_classes.queue_class,
      snapshot_clock.captured_at,
      count(*) filter (
        where task.status in ('pending', 'failed')
          and task.attempts < task.max_attempts
          and task.run_after <= snapshot_clock.captured_at
      )::int as due,
      count(*) filter (
        where task.status in ('pending', 'failed')
          and task.attempts < task.max_attempts
          and task.run_after > snapshot_clock.captured_at
      )::int as scheduled,
      count(*) filter (
        where task.status = 'processing'
          and task.locked_at is not null
          and task.locked_by is not null
          and task.lease_until > snapshot_clock.captured_at
      )::int as active_leases,
      count(*) filter (
        where task.status = 'processing'
          and task.attempts < task.max_attempts
          and task.lease_until < snapshot_clock.captured_at
      )::int as stale_leases,
      count(*) filter (
        where task.status = 'processing'
          and task.attempts >= task.max_attempts
          and task.lease_until < snapshot_clock.captured_at
      )::int as exhausted,
      count(*) filter (
        where task.status in ('pending', 'failed')
          and task.attempts >= task.max_attempts
      )::int as stranded,
      count(*) filter (where task.status = 'dead')::int as dead,
      count(*) filter (
        where (
          task.status = 'processing'
          and (
            task.locked_at is null
            or task.locked_by is null
            or task.lease_until is null
          )
        ) or (
          task.status <> 'processing'
          and (
            task.locked_at is not null
            or task.locked_by is not null
            or task.lease_until is not null
          )
        )
      )::int as fence_anomalies,
      min(task.run_after) filter (
        where task.status in ('pending', 'failed')
          and task.attempts < task.max_attempts
          and task.run_after <= snapshot_clock.captured_at
      ) as oldest_due_at
    from queue_classes
    cross join snapshot_clock
    left join tasks as task on task.queue_class = queue_classes.queue_class
    group by queue_classes.queue_class, queue_classes.sort_order, snapshot_clock.captured_at
    order by queue_classes.sort_order
  `);

  if (rows.length !== TASK_QUEUE_CLASSES.length) {
    throw new Error("Task queue snapshot did not return every queue class");
  }

  const capturedAt = parseTimestamp(rows[0]!.captured_at, "captured_at");
  const queues = rows.map((row, index) => {
    const expectedQueueClass = TASK_QUEUE_CLASSES[index];
    if (!isTaskQueueClass(row.queue_class) || row.queue_class !== expectedQueueClass) {
      throw new Error("Task queue snapshot returned an unexpected queue class");
    }
    const rowCapturedAt = parseTimestamp(row.captured_at, "captured_at");
    if (rowCapturedAt.getTime() !== capturedAt.getTime()) {
      throw new Error("Task queue snapshot returned inconsistent capture clocks");
    }

    return {
      queueClass: row.queue_class,
      due: Number(row.due),
      scheduled: Number(row.scheduled),
      activeLeases: Number(row.active_leases),
      staleLeases: Number(row.stale_leases),
      exhausted: Number(row.exhausted),
      stranded: Number(row.stranded),
      dead: Number(row.dead),
      fenceAnomalies: Number(row.fence_anomalies),
      oldestDueAt:
        row.oldest_due_at === null ? null : parseTimestamp(row.oldest_due_at, "oldest_due_at"),
    };
  });

  return {
    capturedAt,
    totals: queues.reduce(addCounts, EMPTY_COUNTS),
    queues,
  };
}
