import postgres from "postgres";

import { decryptSecret } from "@/lib/crypto";
import { NEUTRALIZED_EMAIL_LAST_ERROR } from "@/modules/restore/neutralize";

const DATABASE_URL = process.env.DATABASE_URL;
const SMTP_MARKER = process.env.SMTP_MARKER ?? "restore-e2e-smtp-host.example.com";
const TIER_SLUG = process.env.TIER_SLUG ?? "restore-e2e-tier";
const QUARANTINE_FILE_ID = process.env.QUARANTINE_FILE_ID;
const INTACT_FILE_ID = process.env.INTACT_FILE_ID;
const RESTORE_APP_URL = process.env.RESTORE_APP_URL ?? "http://app:3000";

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

if (!QUARANTINE_FILE_ID || !INTACT_FILE_ID) {
  console.error("Missing QUARANTINE_FILE_ID or INTACT_FILE_ID");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

function fail(message) {
  console.error(`verify-restore-e2e: ${message}`);
  process.exit(1);
}

async function pollUntil(
  load,
  predicate,
  message,
  { timeoutMs = 90_000, intervalMs = 2_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await load();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      fail(`${message} (last seen: ${JSON.stringify(last)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function loadEmailTaskByTemplate(template) {
  const rows = await sql`
    select status, run_after, last_error, payload_json
    from tasks
    where kind = 'email'
  `;
  return (
    rows.find(
      (row) =>
        typeof row.payload_json === "object" &&
        row.payload_json !== null &&
        row.payload_json.template === template,
    ) ?? null
  );
}

try {
  const [smtpRow] = await sql`
    select value_encrypted
    from app_settings
    where key = 'smtp'
    limit 1
  `;
  if (!smtpRow) fail("encrypted smtp app_settings row missing");
  const valueEncrypted = smtpRow.value_encrypted ?? smtpRow.valueEncrypted;
  if (!valueEncrypted) fail("encrypted smtp app_settings value missing");
  const smtp = JSON.parse(decryptSecret(valueEncrypted));
  if (smtp.host !== SMTP_MARKER) {
    fail(`smtp host decrypt mismatch (got ${smtp.host ?? "null"})`);
  }

  const [membershipCount] = await sql`
    select count(*)::text as count
    from memberships m
    join membership_tiers t on t.id = m.tier_id
    where t.slug = ${TIER_SLUG}
      and m.status = 'active'
  `;
  if (membershipCount?.count !== "1") {
    fail(`expected one active membership for ${TIER_SLUG} (count=${membershipCount?.count})`);
  }

  const [providerEvent] = await sql`
    select id, status, locked_by, attempts
    from payment_provider_events
    where provider = 'stripe'
      and event_type = 'invoice.paid'
    order by created_at desc
    limit 1
  `;
  if (!providerEvent) fail("provider event missing after restore");
  if (providerEvent.status === "processing") {
    fail(
      `provider event still processing after restore (locked_by=${providerEvent.locked_by ?? "null"})`,
    );
  }
  if (!["received", "processed"].includes(providerEvent.status)) {
    fail(`provider event not re-armed (status=${providerEvent.status})`);
  }

  const [dispatchTask] = await sql`
    select status, attempts, locked_by
    from tasks
    where kind = 'payment_provider_event.dispatch'
      and dedupe_key = ${`payment-provider-event:${providerEvent.id}`}
    limit 1
  `;
  if (!dispatchTask) fail("provider dispatch task missing after restore");
  if (dispatchTask.status === "processing" && dispatchTask.locked_by === "stale-worker") {
    fail("provider dispatch task still stranded from snapshot");
  }
  if (providerEvent.status === "received") {
    if (dispatchTask.status !== "pending" || Number(dispatchTask.attempts) !== 0) {
      fail("provider dispatch task not pending with attempts=0");
    }
    if (dispatchTask.locked_by) fail("provider dispatch task still locked");
  } else if (dispatchTask.status !== "succeeded") {
    fail(
      `processed provider event dispatch task expected succeeded (status=${dispatchTask.status})`,
    );
  }

  const activated = await loadEmailTaskByTemplate("membership_activated");
  if (!activated || activated.status !== "dead") {
    fail("membership_activated email task was not neutralized to dead");
  }
  if (activated.last_error !== NEUTRALIZED_EMAIL_LAST_ERROR) {
    fail("membership_activated email task missing neutralization marker");
  }

  // The re-armed renewal_reminder carries a valid payload for a *stale* period, so the
  // worker must drive it to a concrete 'succeeded' (no-op skip) terminal state. An
  // invalid payload (which would land in failed/dead) must not pass this check.
  await pollUntil(
    () => loadEmailTaskByTemplate("renewal_reminder"),
    (task) => task !== null && task.status === "succeeded",
    "renewal_reminder email task did not reach a 'succeeded' no-op terminal state after restore",
  );

  // subscription.reconcile must be re-armed, actually run, and defer itself to the next
  // interval. Assert a concrete deferred-pending state with run_after well into the
  // future (proves a successful run happened) instead of merely "not dead".
  const reconcileDeferredAfterMs = Date.now() + 30 * 60 * 1000;
  await pollUntil(
    async () => {
      const [row] = await sql`
        select status, attempts, locked_by, run_after
        from tasks
        where kind = 'subscription.reconcile'
          and dedupe_key = 'subscription.reconcile'
        limit 1
      `;
      return row ?? null;
    },
    (task) =>
      task !== null &&
      task.status === "pending" &&
      !task.locked_by &&
      task.run_after !== null &&
      new Date(task.run_after).getTime() > reconcileDeferredAfterMs,
    "subscription.reconcile did not defer to the next interval after a successful run",
  );

  const quarantineResponse = await fetch(
    `${RESTORE_APP_URL}/api/files/${QUARANTINE_FILE_ID}/download`,
  );
  if (quarantineResponse.status !== 410) {
    fail(`quarantined file download expected 410 (got ${quarantineResponse.status})`);
  }

  const intactResponse = await fetch(`${RESTORE_APP_URL}/api/files/${INTACT_FILE_ID}/download`);
  if (!intactResponse.ok) {
    fail(`intact file download expected success (got ${intactResponse.status})`);
  }

  console.log(
    JSON.stringify(
      {
        smtpDecrypt: true,
        membership: true,
        providerRearm: true,
        emailNeutralization: true,
        subscriptionReconcile: true,
        quarantine410: true,
        intactDownload: intactResponse.status,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
