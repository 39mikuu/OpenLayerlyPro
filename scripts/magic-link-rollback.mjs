import { createHash, randomUUID } from "node:crypto";

import postgres from "postgres";

import {
  isExactLegacyMagicLinkDeliveryTask,
  isExactMagicLinkDeliveryV2Task,
} from "../src/lib/magic-link-v2-task-graph.js";

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_PENDING_CLEANUP_MINUTES = 30;
const PAGE_SIZE = 100;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const command = process.argv[2];
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

function usage() {
  console.error(`Usage:
  magic-link-rollback.mjs cleanup-aged-null --confirm
  magic-link-rollback.mjs count --scope aged-null|terminal-pending|non-active-unexpired|legacy-delivery-residue
  magic-link-rollback.mjs verify-zero --scope aged-null|terminal-pending|non-active-unexpired|legacy-delivery-residue
  magic-link-rollback.mjs list-terminal [--cursor <createdAt,id>]
  magic-link-rollback.mjs list-legacy-residue [--cursor <createdAt,id>]
  magic-link-rollback.mjs quarantine-legacy-residue --confirm
  magic-link-rollback.mjs neutralize-non-active --actor-id <admin-uuid> --reason <text> \\
    --rollback-attestation <text> --confirm
  magic-link-rollback.mjs abandon --candidate-id <uuid> --reservation-id <uuid> \\
    --actor-id <admin-uuid> --reason <text> --quiescence-attestation <text> \\
    --stopped-instance-ids <comma-separated-ids> --full-quiescence --confirm

The abandon command is intentionally unavailable without a documented full
quiescence attestation. It never infers quiescence from a reservation timeout.`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function requireOption(name) {
  const value = option(name);
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}

function assertUuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function pendingCleanupMinutes() {
  const raw = process.env.MAGIC_LINK_PENDING_CLEANUP_MIN_AGE_MINUTES;
  if (!raw) return DEFAULT_PENDING_CLEANUP_MINUTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_080) {
    throw new Error(
      "MAGIC_LINK_PENDING_CLEANUP_MIN_AGE_MINUTES must be an integer from 1 to 10080",
    );
  }
  return parsed;
}

function parseScope() {
  const scope = requireOption("--scope");
  if (
    scope !== "aged-null" &&
    scope !== "terminal-pending" &&
    scope !== "non-active-unexpired" &&
    scope !== "legacy-delivery-residue"
  ) {
    throw new Error(
      "--scope must be aged-null, terminal-pending, non-active-unexpired, or legacy-delivery-residue",
    );
  }
  return scope;
}

function parseCursor(raw) {
  if (!raw) return null;
  const separator = raw.lastIndexOf(",");
  if (separator <= 0) throw new Error("--cursor must be <createdAt,id>");
  const createdAt = new Date(raw.slice(0, separator));
  const id = assertUuid(raw.slice(separator + 1), "cursor id");
  if (Number.isNaN(createdAt.getTime())) throw new Error("cursor createdAt is invalid");
  return { createdAt, id };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function countScope(scope) {
  const cleanupMinutes = pendingCleanupMinutes();
  if (scope === "legacy-delivery-residue") {
    const [row] = await sql`
      select count(*)::int as count
      from tasks
      where kind = 'auth.magic_link_email'
        and not coalesce(payload_json ? 'deliveryProtocol', false)
        and status in ('pending', 'processing', 'failed')
    `;
    return Number(row?.count ?? 0);
  }
  if (scope === "non-active-unexpired") {
    const [row] = await sql`
      select count(*)::int as count
      from magic_link_tokens
      where delivery_state in ('pending', 'superseded', 'cancelled')
        and consumed_at is null
        and expires_at > now()
    `;
    return Number(row?.count ?? 0);
  }
  const [row] = await sql`
    select count(*)::int as count
    from magic_link_mint_ledger ledger
    join magic_link_tokens token on token.id = ledger.minted_token_id
    join tasks task on task.id = ledger.delivery_task_id
    where token.delivery_state = 'pending'
      and task.status in ('dead', 'succeeded')
      and (
        ${scope} = 'terminal-pending'
        or (
          token.delivery_reservation_id is null
          and token.delivery_reservation_until is null
          and token.created_at <= now() - (${cleanupMinutes} * interval '1 minute')
        )
      )
  `;
  return Number(row?.count ?? 0);
}

async function neutralizeNonActive() {
  if (!hasFlag("--confirm")) {
    throw new Error("neutralize-non-active requires --confirm");
  }
  const actorId = assertUuid(requireOption("--actor-id"), "--actor-id");
  const reason = requireOption("--reason");
  const attestation = requireOption("--rollback-attestation");
  let neutralized = 0;
  while (true) {
    const batch = await sql.begin(async (tx) => {
      const [actor] = await tx`
        select id
        from users
        where id = ${actorId}
          and role = 'admin'
        for key share
      `;
      if (!actor) throw new Error("--actor-id must identify a current administrator");
      const changed = await tx`
        with candidate as (
          select id
          from magic_link_tokens
          where delivery_state in ('pending', 'superseded', 'cancelled')
            and consumed_at is null
            and expires_at > now()
          order by id asc
          limit ${PAGE_SIZE}
          for update skip locked
        )
        update magic_link_tokens token
        set expires_at = now()
        from candidate
        where token.id = candidate.id
        returning token.id, token.delivery_state
      `;
      if (changed.length === 0) return [];
      await tx`
        insert into audit_events (
          id, entity_type, entity_id, action, actor_type, actor_id,
          reason, before_json, after_json, correlation_id, causation_id
        ) values (
          ${randomUUID()}, 'magic_link_rollback', ${changed[0].id}, 'magic_link_non_active_neutralized',
          'admin', ${actorId}, ${reason}, null,
          ${tx.json({
            affectedCandidateIds: changed.map((row) => row.id),
            affectedCount: changed.length,
            rollbackAttestationSha256: createHash("sha256").update(attestation).digest("hex"),
          })},
          ${randomUUID()}, null
        )
      `;
      return changed;
    });
    neutralized += batch.length;
    if (batch.length === 0) break;
  }
  print({ command: "neutralize-non-active", neutralized });
}

async function cleanupCandidate(entry) {
  return sql.begin(async (tx) => {
    // Fixed lock order: task -> email advisory lock -> candidate.
    const [task] = await tx`
      select id, status, kind, queue_class, payload_json
      from tasks
      where id = ${entry.task_id}
      for update
    `;
    if (
      !task ||
      !["dead", "succeeded"].includes(task.status) ||
      !isExactMagicLinkDeliveryV2Task(task, entry.candidate_id)
    ) {
      return false;
    }

    const [preview] = await tx`
      select email
      from magic_link_tokens
      where id = ${entry.candidate_id}
    `;
    if (!preview) return false;
    await tx`select pg_advisory_xact_lock(hashtext(${preview.email}))`;

    const [candidate] = await tx`
      select id, consumed_at, delivery_state, delivery_reservation_id, delivery_reservation_until
      from magic_link_tokens
      where id = ${entry.candidate_id}
      for update
    `;
    if (
      !candidate ||
      candidate.delivery_state !== "pending" ||
      candidate.consumed_at !== null ||
      candidate.delivery_reservation_id !== null ||
      candidate.delivery_reservation_until !== null
    ) {
      return false;
    }

    const [ledger] = await tx`
      select request_id, minted_token_id, delivery_task_id
      from magic_link_mint_ledger
      where minted_token_id = ${candidate.id}
      for update
    `;
    if (!ledger || ledger.delivery_task_id !== task.id) {
      throw new Error("Magic Link cleanup found a mismatched immutable mint ledger");
    }

    const [cancelled] = await tx`
      update magic_link_tokens
      set delivery_state = 'cancelled', expires_at = now()
      where id = ${candidate.id}
        and delivery_state = 'pending'
        and delivery_reservation_id is null
        and delivery_reservation_until is null
      returning id
    `;
    if (!cancelled) return false;

    const [existing] = await tx`
      select final_state, reservation_id
      from magic_link_delivery_dispositions
      where candidate_id = ${candidate.id}
      for update
    `;
    if (existing) {
      if (existing.final_state !== "cancelled" || existing.reservation_id !== null) {
        throw new Error("Magic Link cleanup found a conflicting disposition record");
      }
    } else {
      await tx`
        insert into magic_link_delivery_dispositions (
          candidate_id, request_id, minted_token_id, delivery_task_id, final_state, reservation_id
        ) values (
          ${candidate.id}, ${ledger.request_id}, ${ledger.minted_token_id}, ${ledger.delivery_task_id},
          'cancelled', null
        )
      `;
    }
    await tx`delete from magic_link_stuck_fence_alerts where candidate_id = ${candidate.id}`;
    return true;
  });
}

async function cleanupAgedNull() {
  if (!hasFlag("--confirm")) {
    throw new Error("cleanup-aged-null requires --confirm");
  }
  const cleanupMinutes = pendingCleanupMinutes();
  let cleaned = 0;
  while (true) {
    const entries = await sql`
      select token.id as candidate_id, ledger.delivery_task_id as task_id
      from magic_link_mint_ledger ledger
      join magic_link_tokens token on token.id = ledger.minted_token_id
      join tasks task on task.id = ledger.delivery_task_id
      where token.delivery_state = 'pending'
        and token.delivery_reservation_id is null
        and token.delivery_reservation_until is null
        and token.created_at <= now() - (${cleanupMinutes} * interval '1 minute')
        and task.status in ('dead', 'succeeded')
      order by token.created_at asc, token.id asc
      limit ${PAGE_SIZE}
    `;
    if (entries.length === 0) break;
    let cleanedThisPage = 0;
    for (const entry of entries) {
      if (await cleanupCandidate(entry)) {
        cleaned += 1;
        cleanedThisPage += 1;
      }
    }
    if (cleanedThisPage === 0) break;
  }
  print({ command: "cleanup-aged-null", cleaned });
}

async function listTerminal() {
  const cursor = parseCursor(option("--cursor"));
  const rows = await sql`
    select
      token.id as "candidateId",
      ledger.delivery_task_id as "taskId",
      task.status as "taskStatus",
      token.delivery_reservation_id as "reservationId",
      token.delivery_reservation_until as "reservationUntil",
      token.created_at as "createdAt"
    from magic_link_mint_ledger ledger
    join magic_link_tokens token on token.id = ledger.minted_token_id
    join tasks task on task.id = ledger.delivery_task_id
    where token.delivery_state = 'pending'
      and task.status in ('dead', 'succeeded')
      and (
        ${cursor?.createdAt ?? null}::timestamptz is null
        or (token.created_at, token.id) > (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
      )
    order by token.created_at asc, token.id asc
    limit ${PAGE_SIZE}
  `;
  const last = rows.at(-1);
  print({
    command: "list-terminal",
    items: rows,
    nextCursor: last ? `${new Date(last.createdAt).toISOString()},${last.candidateId}` : null,
  });
}

/**
 * Phase B admits no runnable legacy Magic Link delivery row, including a
 * malformed row which lacks the v2 marker but was placed on another queue.
 * Payload contents are intentionally not emitted because this command is an
 * operator inventory rather than a secret inspection tool.
 */
async function listLegacyResidue() {
  const cursor = parseCursor(option("--cursor"));
  const rows = await sql`
    select
      id as "taskId",
      status as "taskStatus",
      queue_class as "queueClass",
      created_at as "createdAt"
    from tasks
    where kind = 'auth.magic_link_email'
      and not coalesce(payload_json ? 'deliveryProtocol', false)
      and status in ('pending', 'processing', 'failed')
      and (
        ${cursor?.createdAt ?? null}::timestamptz is null
        or (created_at, id) > (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
      )
    order by created_at asc, id asc
    limit ${PAGE_SIZE}
  `;
  const last = rows.at(-1);
  print({
    command: "list-legacy-residue",
    items: rows,
    nextCursor: last ? `${new Date(last.createdAt).toISOString()},${last.taskId}` : null,
  });
}

/**
 * This is deliberately a database-only Phase-B cutover operation. It runs
 * only after every false-gate process and any SMTP I/O have been proven gone;
 * it never imports a mail transport or invokes SMTP. Exact legacy rows are
 * neutralized with their still-unconsumed token, while corrupt rows become a
 * terminal-safe task without touching an unverified candidate.
 */
async function quarantineLegacyTask(taskId) {
  return sql.begin(async (tx) => {
    const [task] = await tx`
      select id, status, kind, dedupe_key, queue_class, payload_json
      from tasks
      where id = ${taskId}
      for update
    `;
    if (!task || !["pending", "processing", "failed"].includes(task.status)) return false;

    const tokenId =
      task.payload_json &&
      typeof task.payload_json === "object" &&
      !Array.isArray(task.payload_json) &&
      typeof task.payload_json.tokenId === "string"
        ? task.payload_json.tokenId
        : null;
    const terminalizeInvalid = async (reason) => {
      await tx`
        update tasks
        set status = 'dead',
            locked_at = null,
            locked_by = null,
            lease_until = null,
            last_error = ${reason},
            updated_at = now()
        where id = ${task.id}
      `;
      await tx`
        insert into audit_events (
          id, entity_type, entity_id, action, actor_type, actor_id,
          reason, before_json, after_json, correlation_id, causation_id
        ) values (
          ${randomUUID()}, 'task', ${task.id}, 'magic_link_legacy_delivery_quarantined_invalid',
          'system', null, ${reason}, null,
          ${tx.json({
            taskId: task.id,
            outcome: "invalid_graph_terminalized",
            phase: "protocol_v2_cutover",
          })},
          ${randomUUID()}, null
        )
      `;
      return true;
    };

    if (!tokenId || !isExactLegacyMagicLinkDeliveryTask(task, tokenId)) {
      return terminalizeInvalid("Legacy Magic Link task graph was quarantined as invalid");
    }

    const [preview] = await tx`
      select email
      from magic_link_tokens
      where id = ${tokenId}
    `;
    if (!preview) {
      return terminalizeInvalid("Legacy Magic Link task candidate was absent during quarantine");
    }

    // Preserve the repository-wide task -> advisory -> token order even though
    // Phase B has already stopped all SMTP-capable false-gate processes.
    await tx`select pg_advisory_xact_lock(hashtext(${preview.email}))`;
    const [candidate] = await tx`
      select id, consumed_at, delivery_state, delivery_reservation_id, delivery_reservation_until
      from magic_link_tokens
      where id = ${tokenId}
      for update
    `;
    if (
      !candidate ||
      candidate.delivery_state !== "active" ||
      candidate.delivery_reservation_id !== null ||
      candidate.delivery_reservation_until !== null
    ) {
      return terminalizeInvalid("Legacy Magic Link candidate graph was unsafe to quarantine");
    }

    let outcome = "already_consumed";
    if (candidate.consumed_at === null) {
      const [neutralized] = await tx`
        update magic_link_tokens
        set delivery_state = 'cancelled',
            expires_at = now()
        where id = ${candidate.id}
          and delivery_state = 'active'
          and consumed_at is null
          and delivery_reservation_id is null
          and delivery_reservation_until is null
        returning id
      `;
      if (!neutralized) {
        throw new Error("Legacy Magic Link candidate changed during quarantine");
      }
      outcome = "token_neutralized";
    }

    await tx`
      update tasks
      set status = 'succeeded',
          locked_at = null,
          locked_by = null,
          lease_until = null,
          last_error = 'Legacy Magic Link delivery quarantined during protocol-v2 cutover',
          updated_at = now()
      where id = ${task.id}
    `;
    await tx`
      insert into audit_events (
        id, entity_type, entity_id, action, actor_type, actor_id,
        reason, before_json, after_json, correlation_id, causation_id
      ) values (
        ${randomUUID()}, 'magic_link', ${candidate.id}, 'magic_link_legacy_delivery_quarantined',
        'system', null, 'Protocol-v2 cutover quarantined a legacy delivery task', null,
        ${tx.json({
          taskId: task.id,
          outcome,
          phase: "protocol_v2_cutover",
        })},
        ${randomUUID()}, null
      )
    `;
    return true;
  });
}

async function quarantineLegacyResidue() {
  if (!hasFlag("--confirm")) {
    throw new Error("quarantine-legacy-residue requires --confirm");
  }
  let terminalized = 0;
  while (true) {
    const entries = await sql`
      select id
      from tasks
      where kind = 'auth.magic_link_email'
        and not coalesce(payload_json ? 'deliveryProtocol', false)
        and status in ('pending', 'processing', 'failed')
      order by created_at asc, id asc
      limit ${PAGE_SIZE}
    `;
    if (entries.length === 0) break;
    let terminalizedThisPage = 0;
    for (const entry of entries) {
      if (await quarantineLegacyTask(entry.id)) {
        terminalized += 1;
        terminalizedThisPage += 1;
      }
    }
    if (terminalizedThisPage === 0) break;
  }
  print({ command: "quarantine-legacy-residue", terminalized });
}

async function abandon() {
  if (!hasFlag("--confirm") || !hasFlag("--full-quiescence")) {
    throw new Error("abandon requires both --full-quiescence and --confirm");
  }
  const candidateId = assertUuid(requireOption("--candidate-id"), "--candidate-id");
  const reservationId = assertUuid(requireOption("--reservation-id"), "--reservation-id");
  const actorId = assertUuid(requireOption("--actor-id"), "--actor-id");
  const reason = requireOption("--reason");
  const attestation = requireOption("--quiescence-attestation");
  const stoppedInstanceIds = requireOption("--stopped-instance-ids")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (stoppedInstanceIds.length === 0) {
    throw new Error("--stopped-instance-ids must name every stopped execution environment");
  }
  const result = await sql.begin(async (tx) => {
    // Locate without a row lock, then take the global task -> advisory ->
    // candidate -> ledger order below. Locking the ledger first would deadlock
    // against a live worker that already owns the task and reaches its ledger
    // validation after taking the candidate lock.
    const [ledgerPreview] = await tx`
      select request_id, minted_token_id, delivery_task_id
      from magic_link_mint_ledger
      where minted_token_id = ${candidateId}
    `;
    if (!ledgerPreview) throw new Error("No v2 mint ledger exists for candidate");
    const [task] = await tx`
      select id, status, kind, queue_class, payload_json
      from tasks
      where id = ${ledgerPreview.delivery_task_id}
      for update
    `;
    if (
      !task ||
      !["dead", "succeeded"].includes(task.status) ||
      !isExactMagicLinkDeliveryV2Task(task, candidateId)
    ) {
      throw new Error("abandon requires a terminal protocol-v2 delivery task linked to candidate");
    }
    const [preview] = await tx`
      select email
      from magic_link_tokens
      where id = ${candidateId}
    `;
    if (!preview) throw new Error("Candidate no longer exists");
    await tx`select pg_advisory_xact_lock(hashtext(${preview.email}))`;
    const [candidate] = await tx`
      select id, consumed_at, delivery_state, delivery_reservation_id, delivery_reservation_until
      from magic_link_tokens
      where id = ${candidateId}
      for update
    `;
    if (!candidate) {
      throw new Error("Candidate no longer exists");
    }
    const [ledger] = await tx`
      select request_id, minted_token_id, delivery_task_id
      from magic_link_mint_ledger
      where minted_token_id = ${candidateId}
      for update
    `;
    if (!ledger || ledger.minted_token_id !== candidateId || ledger.delivery_task_id !== task.id) {
      throw new Error("Magic Link candidate/task mint ledger changed during abandon");
    }
    const [existingDisposition] = await tx`
      select final_state, reservation_id
      from magic_link_delivery_dispositions
      where candidate_id = ${candidateId}
      for update
    `;
    if (
      candidate.delivery_state !== "pending" ||
      candidate.consumed_at !== null ||
      candidate.delivery_reservation_id !== reservationId
    ) {
      if (
        existingDisposition?.final_state === "abandoned" &&
        existingDisposition.reservation_id === reservationId
      ) {
        return { candidateId, taskId: task.id, status: "already_abandoned" };
      }
      throw new Error("Candidate no longer has the specified reservation generation");
    }
    const [request] = await tx`
      select minted_token_id
      from magic_link_requests
      where id = ${ledger.request_id}
      for key share
    `;
    if (request && request.minted_token_id !== candidateId) {
      throw new Error("Retained request does not match the immutable mint ledger");
    }
    const [liveReference] = await tx`
      select id
      from tasks
      where id <> ${task.id}
        and payload_json->>'tokenId' = ${candidateId}
        and status in ('pending', 'processing', 'failed')
      limit 1
    `;
    if (liveReference) throw new Error("Candidate still has a live or retryable task reference");
    const [actor] = await tx`
      select id
      from users
      where id = ${actorId}
        and role = 'admin'
      for key share
    `;
    if (!actor) throw new Error("--actor-id must identify a current administrator");

    const [cancelled] = await tx`
      update magic_link_tokens
      set delivery_state = 'cancelled',
          expires_at = now(),
          delivery_reservation_id = null,
          delivery_reservation_until = null
      where id = ${candidateId}
        and delivery_state = 'pending'
        and consumed_at is null
        and delivery_reservation_id = ${reservationId}
      returning id
    `;
    if (!cancelled) throw new Error("Candidate abandon lost its exact reservation generation");

    if (existingDisposition) {
      if (
        existingDisposition.final_state !== "abandoned" ||
        existingDisposition.reservation_id !== reservationId
      ) {
        throw new Error("Candidate has a conflicting disposition record");
      }
    } else {
      await tx`
        insert into magic_link_delivery_dispositions (
          candidate_id, request_id, minted_token_id, delivery_task_id, final_state, reservation_id
        ) values (
          ${candidateId}, ${ledger.request_id}, ${ledger.minted_token_id}, ${ledger.delivery_task_id},
          'abandoned', ${reservationId}
        )
      `;
    }
    await tx`
      delete from magic_link_stuck_fence_alerts
      where candidate_id = ${candidateId}
        and reservation_id = ${reservationId}
    `;
    await tx`
      insert into audit_events (
        id, entity_type, entity_id, action, actor_type, actor_id,
        reason, before_json, after_json, correlation_id, causation_id
      ) values (
        ${randomUUID()}, 'magic_link', ${candidateId}, 'magic_link_reservation_abandoned',
        'admin', ${actorId}, ${reason}, null,
        ${tx.json({
          taskId: task.id,
          reservationId,
          previousReservationUntil: candidate.delivery_reservation_until?.toISOString() ?? null,
          fullQuiescenceAttested: true,
          quiescenceAttestation: attestation,
          attestationSha256: createHash("sha256").update(attestation).digest("hex"),
          stoppedInstanceIds,
          affectedCount: 1,
        })},
        ${randomUUID()}, null
      )
    `;
    return { candidateId, taskId: task.id, status: "abandoned" };
  });
  print({ command: "abandon", ...result });
}

try {
  if (command === "cleanup-aged-null") {
    await cleanupAgedNull();
  } else if (command === "count") {
    const scope = parseScope();
    print({ command: "count", scope, count: await countScope(scope) });
  } else if (command === "verify-zero") {
    const scope = parseScope();
    const count = await countScope(scope);
    print({ command: "verify-zero", scope, count });
    if (count !== 0) process.exitCode = 3;
  } else if (command === "list-terminal") {
    await listTerminal();
  } else if (command === "list-legacy-residue") {
    await listLegacyResidue();
  } else if (command === "quarantine-legacy-residue") {
    await quarantineLegacyResidue();
  } else if (command === "neutralize-non-active") {
    await neutralizeNonActive();
  } else if (command === "abandon") {
    await abandon();
  } else {
    usage();
    process.exitCode = 64;
  }
} catch (error) {
  console.error(
    "Magic Link rollback maintenance failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
