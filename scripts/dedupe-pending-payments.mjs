#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import postgres from "postgres";

function parseArgs(argv) {
  const options = { apply: false, resolve: "cancelled" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--keep") options.keep = argv[++i];
    else if (arg === "--resolve") options.resolve = argv[++i];
    else if (arg === "--actor-id") options.actorId = argv[++i];
    else if (arg === "--reason") options.reason = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/dedupe-pending-payments.mjs
  node scripts/dedupe-pending-payments.mjs --keep <request-id> --resolve cancelled|rejected --dry-run
  node scripts/dedupe-pending-payments.mjs --keep <request-id> --resolve cancelled|rejected --apply --actor-id <admin-id> --reason <text>

Without --apply the command only reports or previews changes. It never deletes payment records.`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!new Set(["cancelled", "rejected"]).has(options.resolve)) {
  throw new Error("--resolve must be cancelled or rejected");
}
if (options.apply && (!options.keep || !options.actorId || !options.reason?.trim())) {
  throw new Error("--apply requires --keep, --actor-id, and a non-empty --reason");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

try {
  if (!options.keep) {
    const conflicts = await sql`
      select user_id, tier_id, count(*)::integer as count,
             array_agg(id order by created_at, id) as request_ids
        from payment_requests
       where status in ('pending_review', 'pending_payment')
       group by user_id, tier_id
      having count(*) > 1
       order by user_id, tier_id
    `;
    console.log(JSON.stringify({ mode: "report", conflicts }, null, 2));
    process.exitCode = conflicts.length === 0 ? 0 : 2;
  } else {
    const summary = await sql.begin(async (tx) => {
      if (options.apply) {
        const [actor] = await tx`
          select id
            from users
           where id = ${options.actorId}
             and role = 'admin'
           limit 1
        `;
        if (!actor) {
          throw new Error(`Actor must reference an existing admin user: ${options.actorId}`);
        }
      }

      const [target] = await tx`
      select id, user_id, tier_id
        from payment_requests
       where id = ${options.keep}
       limit 1
    `;
      if (!target) throw new Error(`Keep request not found: ${options.keep}`);

      await tx`
      select pg_advisory_xact_lock(
        hashtextextended(${"payment-pending:" + target.user_id}, 0)
      )
    `;
      const [keep] = await tx`
      select id, user_id, tier_id, status
        from payment_requests
       where id = ${options.keep}
       limit 1
       for update
    `;
      if (!keep) throw new Error(`Keep request not found: ${options.keep}`);
      if (!new Set(["pending_review", "pending_payment"]).has(keep.status)) {
        return {
          mode: options.apply ? "apply" : "dry-run",
          keepRequestId: keep.id,
          changed: [],
          message: "The selected keep request is no longer pending; no changes were made.",
        };
      }

      const pending = await tx`
      select id, status, flow, provider, created_at
        from payment_requests
       where user_id = ${keep.user_id}
         and tier_id = ${keep.tier_id}
         and status in ('pending_review', 'pending_payment')
       order by created_at, id
       for update
    `;
      const losers = pending.filter((row) => row.id !== keep.id);
      const base = {
        mode: options.apply ? "apply" : "dry-run",
        userId: keep.user_id,
        tierId: keep.tier_id,
        keepRequestId: keep.id,
        resolutionStatus: options.resolve,
        candidates: pending,
      };
      if (losers.length === 0) {
        return { ...base, changed: [], message: "No duplicate pending requests remain." };
      }
      if (!options.apply) {
        return { ...base, wouldChange: losers.map((row) => row.id), changed: [] };
      }

      const correlationId = randomUUID();
      const changed = [];
      for (const row of losers) {
        const [updated] = await tx`
        update payment_requests
           set status = ${options.resolve},
               review_note = coalesce(review_note, ${options.reason.trim()}),
               reviewed_by = ${options.actorId},
               reviewed_at = now(),
               updated_at = now()
         where id = ${row.id}
           and status in ('pending_review', 'pending_payment')
        returning id, status
      `;
        if (!updated) continue;
        await tx`
        insert into audit_events (
          entity_type, entity_id, action, actor_type, actor_id, reason,
          before_json, after_json, correlation_id
        ) values (
          'payment_request', ${row.id}, 'dedupe_pending_payment', 'admin',
          ${options.actorId}, ${options.reason.trim()},
          ${sql.json({ status: row.status })},
          ${sql.json({ status: options.resolve, keptRequestId: keep.id })},
          ${correlationId}
        )
      `;
        changed.push(updated.id);
      }
      return { ...base, correlationId, changed };
    });

    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await sql.end({ timeout: 5 });
}
