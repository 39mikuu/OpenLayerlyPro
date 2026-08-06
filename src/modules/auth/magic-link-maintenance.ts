import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { magicLinkMintLedger, magicLinkRequests, magicLinkTokens, tasks } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { isExactMagicLinkDeliveryV2Task } from "@/lib/magic-link-v2-task-graph";
import {
  clearMagicLinkStuckFenceAlert,
  recordMagicLinkDisposition,
} from "@/modules/auth/magic-link-fence";
import { recordEvent } from "@/modules/system/events";

type TerminalCandidate = { candidateId: string; taskId: string };

type ResolvedRequestTask = { requestId: string; taskId: string };

/**
 * Retain public request rows until their source-budget window has elapsed and
 * the immutable mint ledger can carry the remaining audit/disposition link.
 * Dead or unresolved intake tasks are deliberately absent from this selector.
 */
export async function cleanupRetainedMagicLinkRequests(): Promise<number> {
  const env = getEnv();
  const candidates = await getDb().execute<ResolvedRequestTask>(sql`
    select request.id as "requestId", task.id as "taskId"
    from magic_link_requests request
    join tasks task
      on task.dedupe_key = ('auth-magic-link-request:' || request.id::text)
    where request.resolved_at is not null
      and task.kind = 'auth.magic_link_request'
      and task.status = 'succeeded'
      and greatest(request.created_at, coalesce(request.minted_at, request.created_at))
        <= now() - (${env.MAGIC_LINK_REQUEST_RETENTION_MINUTES} * interval '1 minute')
    order by greatest(request.created_at, coalesce(request.minted_at, request.created_at)) asc, request.id asc
    limit 50
  `);

  let removed = 0;
  for (const entry of candidates) {
    const deleted = await getDb().transaction(async (tx) => {
      // Keep the durability graph lock order explicit: task -> request ->
      // immutable ledger. There is no user/token state transition here.
      const [task] = await tx
        .select({ id: tasks.id, kind: tasks.kind, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, entry.taskId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!task || task.kind !== "auth.magic_link_request" || task.status !== "succeeded") {
        return false;
      }

      const [request] = await tx
        .select()
        .from(magicLinkRequests)
        .where(eq(magicLinkRequests.id, entry.requestId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!request || !request.resolvedAt) return false;
      if (
        request.createdAt.getTime() + env.MAGIC_LINK_REQUEST_RETENTION_MINUTES * 60_000 >
        Date.now()
      ) {
        return false;
      }

      if (request.mintedAt || request.mintedTokenId) {
        if (!request.mintedAt || !request.mintedTokenId) {
          throw new Error("Magic Link request has a partial committed mint ledger pointer");
        }
        if (request.mintedAt.getTime() + env.REQUEST_CODE_RATE_WINDOW_MS > Date.now()) {
          return false;
        }
        const [ledger] = await tx
          .select({
            mintedTokenId: magicLinkMintLedger.mintedTokenId,
            mintedAt: magicLinkMintLedger.mintedAt,
          })
          .from(magicLinkMintLedger)
          .where(eq(magicLinkMintLedger.requestId, request.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (
          !ledger ||
          ledger.mintedTokenId !== request.mintedTokenId ||
          ledger.mintedAt.getTime() !== request.mintedAt.getTime()
        ) {
          throw new Error("Magic Link request retention found a missing or mismatched mint ledger");
        }
      }

      await tx.delete(tasks).where(eq(tasks.id, task.id));
      const [removedRequest] = await tx
        .delete(magicLinkRequests)
        .where(eq(magicLinkRequests.id, request.id))
        .returning({ id: magicLinkRequests.id });
      return Boolean(removedRequest);
    });
    if (deleted) removed += 1;
  }
  return removed;
}

/**
 * A terminal task with no reservation has proven that no SMTP I/O can resume.
 * It is therefore safe to cancel the pending candidate. This routine never
 * touches a non-null reservation: that is a stuck fence, not ordinary cleanup.
 */
export async function reconcileTerminalMagicLinkDeliveries(): Promise<number> {
  const candidates = await getDb().execute<TerminalCandidate>(sql`
    select token.id as "candidateId", ledger.delivery_task_id as "taskId"
    from magic_link_mint_ledger ledger
    join magic_link_tokens token on token.id = ledger.minted_token_id
    join tasks task on task.id = ledger.delivery_task_id
    where token.delivery_state = 'pending'
      and token.delivery_reservation_id is null
      and token.delivery_reservation_until is null
      and task.status in ('dead', 'succeeded')
      and token.created_at <= now() - (${getEnv().MAGIC_LINK_PENDING_CLEANUP_MIN_AGE_MINUTES} * interval '1 minute')
    order by token.created_at asc, token.id asc
    limit 50
  `);

  let reconciled = 0;
  for (const entry of candidates) {
    const changed = await getDb().transaction(async (tx) => {
      // Lock order intentionally remains task -> email advisory lock -> token.
      const [task] = await tx
        .select({
          id: tasks.id,
          status: tasks.status,
          kind: tasks.kind,
          queueClass: tasks.queueClass,
          payloadJson: tasks.payloadJson,
        })
        .from(tasks)
        .where(eq(tasks.id, entry.taskId))
        .limit(1)
        .for("update");
      if (
        !task ||
        (task.status !== "dead" && task.status !== "succeeded") ||
        !isExactMagicLinkDeliveryV2Task(task, entry.candidateId)
      ) {
        return false;
      }

      const [preview] = await tx
        .select({ email: magicLinkTokens.email })
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.id, entry.candidateId))
        .limit(1);
      if (!preview) return false;

      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${preview.email}))`);
      const [candidate] = await tx
        .select({
          id: magicLinkTokens.id,
          deliveryState: magicLinkTokens.deliveryState,
          deliveryReservationId: magicLinkTokens.deliveryReservationId,
          deliveryReservationUntil: magicLinkTokens.deliveryReservationUntil,
        })
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.id, entry.candidateId))
        .limit(1)
        .for("update");
      if (
        !candidate ||
        candidate.deliveryState !== "pending" ||
        candidate.deliveryReservationId !== null ||
        candidate.deliveryReservationUntil !== null
      ) {
        return false;
      }

      const [ledger] = await tx
        .select({ deliveryTaskId: magicLinkMintLedger.deliveryTaskId })
        .from(magicLinkMintLedger)
        .where(eq(magicLinkMintLedger.mintedTokenId, candidate.id))
        .limit(1)
        .for("update");
      if (ledger?.deliveryTaskId !== entry.taskId) {
        throw new Error("Magic Link terminal cleanup found a mismatched mint ledger");
      }

      const [cancelled] = await tx
        .update(magicLinkTokens)
        .set({ deliveryState: "cancelled", expiresAt: sql`now()` })
        .where(
          and(
            eq(magicLinkTokens.id, candidate.id),
            eq(magicLinkTokens.deliveryState, "pending"),
            isNull(magicLinkTokens.deliveryReservationId),
            isNull(magicLinkTokens.deliveryReservationUntil),
          ),
        )
        .returning({ id: magicLinkTokens.id });
      if (!cancelled) return false;
      await recordMagicLinkDisposition(tx, {
        candidateId: candidate.id,
        finalState: "cancelled",
        reservationId: null,
      });
      await clearMagicLinkStuckFenceAlert(tx, { candidateId: candidate.id });
      return true;
    });
    if (changed) reconciled += 1;
  }
  return reconciled;
}

type StuckFence = {
  candidateId: string;
  reservationId: string;
  taskStatus: "pending" | "processing" | "succeeded" | "failed" | "dead" | null;
};

/**
 * Alert—but never release—an overdue or terminal-owned reservation. The
 * compound alert key makes the side effect idempotent across dispatcher
 * replicas and preserves a conservative promotion/mint fence for recovery.
 */
export async function alertOnStuckMagicLinkFences(): Promise<number> {
  const env = getEnv();
  const candidates = await getDb().execute<StuckFence>(sql`
    select
      token.id as "candidateId",
      token.delivery_reservation_id as "reservationId",
      task.status as "taskStatus"
    from magic_link_tokens token
    left join magic_link_mint_ledger ledger on ledger.minted_token_id = token.id
    left join tasks task on task.id = ledger.delivery_task_id
    where token.delivery_state = 'pending'
      and token.delivery_reservation_id is not null
      and token.delivery_reservation_until is not null
      and (
        token.delivery_reservation_until < now()
        or task.id is null
        or task.status in ('dead', 'succeeded')
      )
    order by token.created_at asc, token.id asc
    limit ${env.MAGIC_LINK_STUCK_FENCE_MAX_PER_SWEEP}
  `);

  let alerted = 0;
  for (const entry of candidates) {
    const notified = await getDb().transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          deliveryState: magicLinkTokens.deliveryState,
          deliveryReservationId: magicLinkTokens.deliveryReservationId,
          deliveryReservationUntil: magicLinkTokens.deliveryReservationUntil,
        })
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.id, entry.candidateId))
        .limit(1)
        .for("update");
      if (
        !candidate ||
        candidate.deliveryState !== "pending" ||
        candidate.deliveryReservationId !== entry.reservationId ||
        candidate.deliveryReservationUntil === null
      ) {
        return false;
      }

      const [ledger] = await tx
        .select({ deliveryTaskId: magicLinkMintLedger.deliveryTaskId })
        .from(magicLinkMintLedger)
        .where(eq(magicLinkMintLedger.mintedTokenId, entry.candidateId))
        .limit(1);
      const [task] = ledger
        ? await tx
            .select({ status: tasks.status })
            .from(tasks)
            .where(eq(tasks.id, ledger.deliveryTaskId))
            .limit(1)
        : [undefined];
      const taskIsTerminal = task?.status === "dead" || task?.status === "succeeded";
      if (candidate.deliveryReservationUntil > new Date() && ledger && !taskIsTerminal) {
        return false;
      }

      const rows = await tx.execute<{ candidateId: string }>(sql`
        insert into magic_link_stuck_fence_alerts (
          candidate_id, reservation_id, last_notified_at, updated_at
        ) values (
          ${entry.candidateId}, ${entry.reservationId}, now(), now()
        )
        on conflict (candidate_id, reservation_id) do update
        set last_notified_at = excluded.last_notified_at,
            updated_at = excluded.updated_at
        where magic_link_stuck_fence_alerts.last_notified_at
          <= now() - (${env.MAGIC_LINK_STUCK_FENCE_ALERT_INTERVAL_SECONDS} * interval '1 second')
        returning candidate_id as "candidateId"
      `);
      return rows.length > 0;
    });
    if (!notified) continue;
    alerted += 1;
    await recordEvent("magic_link_stuck_fence", {
      candidateId: entry.candidateId,
      reservationId: entry.reservationId,
      taskStatus: entry.taskStatus,
    });
  }
  return alerted;
}

type DeadIntake = { taskId: string; attempts: number; createdAt: Date };

/** A dead intake has no safe automatic resolution path, so make it durable and visible. */
export async function alertOnDeadMagicLinkIntakes(): Promise<number> {
  const env = getEnv();
  const tasksToAlert = await getDb().execute<DeadIntake>(sql`
    select id as "taskId", attempts, created_at as "createdAt"
    from tasks
    where kind = 'auth.magic_link_request'
      and status = 'dead'
    order by created_at asc, id asc
    limit ${env.MAGIC_LINK_STUCK_FENCE_MAX_PER_SWEEP}
  `);

  let alerted = 0;
  for (const entry of tasksToAlert) {
    const notified = await getDb().transaction(async (tx) => {
      const [task] = await tx
        .select({ kind: tasks.kind, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, entry.taskId))
        .limit(1)
        .for("update");
      if (!task || task.kind !== "auth.magic_link_request" || task.status !== "dead") return false;

      const rows = await tx.execute<{ taskId: string }>(sql`
        insert into magic_link_dead_intake_alerts (
          task_id, last_notified_at, updated_at
        ) values (
          ${entry.taskId}, now(), now()
        )
        on conflict (task_id) do update
        set last_notified_at = excluded.last_notified_at,
            updated_at = excluded.updated_at
        where magic_link_dead_intake_alerts.last_notified_at
          <= now() - (${env.MAGIC_LINK_STUCK_FENCE_ALERT_INTERVAL_SECONDS} * interval '1 second')
        returning task_id as "taskId"
      `);
      return rows.length > 0;
    });
    if (!notified) continue;
    alerted += 1;
    await recordEvent("magic_link_intake_dead", {
      taskId: entry.taskId,
      attempts: entry.attempts,
      ageMs: Math.max(0, Date.now() - entry.createdAt.getTime()),
      status: "dead",
    });
  }
  return alerted;
}

export async function maintainMagicLinkDeliveryState(): Promise<void> {
  await cleanupRetainedMagicLinkRequests();
  await reconcileTerminalMagicLinkDeliveries();
  await alertOnStuckMagicLinkFences();
  await alertOnDeadMagicLinkIntakes();
}
