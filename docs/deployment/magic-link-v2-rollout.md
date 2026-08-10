# Magic Link protocol-v2 rollout and rollback

This runbook is mandatory for the security migration introduced by Issue #184.
It applies to every deployment that can serve Web/API traffic, run the task
dispatcher, execute an administrator promotion, or run a production
maintenance bundle. It is not a generic feature-flag procedure.

The public request path is role-blind only when protocol v2 is enabled. A
legacy process does not understand `delivery_state`, the SMTP reservation
generation, or the `admin-reset` promotion fence. Queue-class isolation alone
does not make a mixed deployment safe.

## Preconditions

Record the current image digest/revision, target image digest/revision, active
instance IDs, and the operator responsible for the rollout. Confirm the target
image contains all of these files before changing traffic:

```text
dist/migrate.mjs
dist/admin-reset.mjs
dist/magic-link-rollback.mjs
```

The target runtime parses `MAGIC_LINK_INTAKE_ENABLED` as exactly `true` or
`false` and caches environment variables at process start. `TASK_AUTH_INTAKE_MAX_PER_BATCH`
MUST be at least `1` at all times.

## Phase A — compatibility deployment

1. Take the normal pre-upgrade recovery point.
2. Apply migrations `0031`–`0034` with the target image. Historical tokens are
   backfilled as `active`/`delivered`; this does not make legacy binaries safe
   to run with protocol-v2 state.
3. Deploy every new Web/API, dispatcher, administrative operation and
   production command environment with:

   ```text
   MAGIC_LINK_INTAKE_ENABLED=false
   TASK_AUTH_INTAKE_MAX_PER_BATCH>=1
   ```

   In this phase the new code continues the legacy Magic Link path and MUST
   NOT create `auth.magic_link_request`, a pending candidate, or a v2 delivery
   task.
4. Produce a zero-legacy-instance inventory. For every old Web/API instance,
   dispatcher/worker, CronJob/retry job, admin operation, serverless revision,
   and executable maintenance environment (including `docker exec`, CI,
   recovery images, `admin-reset`, and rollback bundles), record its image
   digest, instance ID, stop event, and the disabled restart/scheduler source.
5. Verify that an old image cannot be recreated by an autoscaler, suspended
   job, cached command, or retained operator credential. Keeping an old image
   for emergency rollback is allowed only when deployment controls prove it
   cannot run in Phase B.

An empty queue, an expired worker lease, or an old dispatcher that cannot see
the new queue is not exit proof. Old verifier/consumer code can still use
legacy expiry predicates; old promotion and recovery code can still cross an
SMTP fence.

## Phase B — enable protocol v2

Only after the Phase-A inventory is complete, make a second configuration
deployment with:

```text
MAGIC_LINK_INTAKE_ENABLED=true
TASK_AUTH_INTAKE_MAX_PER_BATCH>=1
```

Phase B is a **stop-then-start cutover**, not a rolling configuration change.
Before any `true` process accepts traffic, claims a task, performs an
administrator promotion, or executes an operations bundle, the operator MUST:

1. remove Web/API and administrator traffic, pause schedulers, and stop every
   process started with `MAGIC_LINK_INTAKE_ENABLED=false`. This includes the
   new Phase-A target-image Web/API, dispatcher, admin-operation and production
   bundle environments—not only an older image;
2. record the image digest, instance ID, stop event, disabled restart source,
   and zero-running-instance proof for every such process; and
3. prove there is no paused, retryable, resumable, or otherwise recoverable
   legacy SMTP I/O. A `false` worker that has acquired a legacy task claim is
   not safely gone until its process and SMTP connection are gone. An expired
   lease, an empty queue, or a new queue-class boundary is not that proof.

No `true` process may begin while a `false` process or its possible SMTP I/O
exists. In particular, `setupSite`, `changeAdminEmail`, `admin-reset`, rollback
commands, and general Web/API traffic MUST remain unavailable during this
cutover barrier.

Only after that proof, keep every ordinary dispatcher stopped. Do not start
normal Web/API, administrator, SMTP-capable maintenance, or task-dispatcher
entrypoints yet. Run only the target image's database-only
`magic-link-rollback.mjs list/count/verify-zero` and
`quarantine-legacy-residue` commands below. They are the sole approved
operations exception during the cutover barrier and drain/account for every
**runnable** legacy delivery task:

```bash
docker compose run --rm -T --no-deps --entrypoint node app \
  /app/dist/magic-link-rollback.mjs list-legacy-residue
docker compose run --rm -T --no-deps --entrypoint node app \
  /app/dist/magic-link-rollback.mjs quarantine-legacy-residue --confirm
docker compose run --rm -T --no-deps --entrypoint node app \
  /app/dist/magic-link-rollback.mjs list-legacy-residue
docker compose run --rm -T --no-deps --entrypoint node app \
  /app/dist/magic-link-rollback.mjs count --scope legacy-delivery-residue
docker compose run --rm -T --no-deps --entrypoint node app \
  /app/dist/magic-link-rollback.mjs verify-zero --scope legacy-delivery-residue
```

Repeat `list-legacy-residue` with its cursor until its page is empty. The scope
includes every `pending`, `processing`, or retryable-`failed`
`auth.magic_link_email` row without the v2 `deliveryProtocol` marker, even if a
corrupt row sits in the v2 queue. A nonzero count blocks Phase-B completion.
The database-only quarantine command turns an exact Phase-A legacy
transactional row into a terminal task result and neutralizes its unconsumed
active token without SMTP; malformed task/queue/payload graphs terminalize
safely without touching an unverified candidate. The runtime gate provides the
same no-SMTP behavior if a task is claimed defensively. Neither mechanism is a
substitute for the no-overlap exit proof or the explicit count/list/verify-zero
evidence.

Only after `verify-zero` succeeds may normal approved `true` Web/API,
dispatcher, administrator-operation, and maintenance environments start and
traffic resume. Record their image digest/revision and active instance IDs. If
any legacy, `false`, or unverified bundle remains runnable at any point, Phase
B is blocked.

The database trigger and epoch placeholder are defense in depth: pending
tokens are not consumable by old expiry-only code, and a direct old consumer
update of any non-active row is rejected. They do not make an old verifier,
old promotion path, or old maintenance bundle safe; in particular, a legacy
verifier can still interpret a future-dated superseded/cancelled row without
lifecycle awareness. They never replace the two phases above.

## Operations while v2 is enabled

A pending candidate with any non-NULL reservation UUID is a hard promotion
fence, even if `delivery_reservation_until` is in the past or its task is
terminal. `admin-reset` exits `2` rather than promotes through such a fence.
Do not delete, edit, or expire the reservation by hand. The dispatcher emits
deduplicated stuck-fence alerts and retains the candidate for recovery.

Use the production bundle without source tooling:

```bash
docker compose exec app node dist/magic-link-rollback.mjs count --scope terminal-pending
docker compose exec app node dist/magic-link-rollback.mjs list-terminal
```

The output carries opaque IDs only; collect audit and platform evidence outside
the command output.

## Rollback to a legacy image

Rollback restores the pre-Issue-184 request signal and is a security downgrade.
It MUST follow this order:

1. Roll every v2 process to `MAGIC_LINK_INTAKE_ENABLED=false` and verify each
   process restarted with that value.
2. Keep `TASK_AUTH_INTAKE_MAX_PER_BATCH>=1` until `auth_intake` pending,
   processing, and retryable-failed residue is zero. A cap of zero is not a
   drain.
3. Use the new image to resolve dead intake work and execute the ordinary
   two-NULL cleanup. Then use the exact evidence chain:

   ```bash
   node dist/magic-link-rollback.mjs cleanup-aged-null --confirm
   node dist/magic-link-rollback.mjs count --scope aged-null
   node dist/magic-link-rollback.mjs verify-zero --scope aged-null
   node dist/magic-link-rollback.mjs list-terminal
   node dist/magic-link-rollback.mjs count --scope terminal-pending
   node dist/magic-link-rollback.mjs verify-zero --scope terminal-pending
   ```

   Repeat `list-terminal` from its empty cursor until it is empty. Any nonzero
   count, nonempty page, missing audit record, or non-NULL reservation blocks
   the rollback.
4. A non-NULL reservation may be abandoned only during full quiescence: stop
   and prevent restart of every SMTP-capable process, dispatcher, promotion
   operation, old/new bundle, job, and paused/resumable I/O source. Record the
   complete stopped-instance list and an attestation. Then, and only then, run
   one reviewed command per candidate:

   ```bash
   node dist/magic-link-rollback.mjs abandon \
     --candidate-id <uuid> --reservation-id <uuid> --actor-id <admin-uuid> \
     --reason '<reviewed reason>' --quiescence-attestation '<evidence ref>' \
     --stopped-instance-ids '<all-instance-ids>' --full-quiescence --confirm
   ```

   The command rechecks the exact task, candidate, reservation generation,
   immutable mint ledger, optional retained request pointer, and admin actor in
   one transaction. It writes an `abandoned` disposition and audit record or
   fails without clearing the fence. A stale timeout is never quiescence proof.
5. Before any legacy verifier, consumer, Web/API or bundle can run, neutralize
   non-active unconsumed tokens with an audited operator and rollback
   attestation:

   ```bash
   node dist/magic-link-rollback.mjs neutralize-non-active \
     --actor-id <admin-uuid> --reason '<rollback reason>' \
     --rollback-attestation '<evidence ref>' --confirm
   node dist/magic-link-rollback.mjs verify-zero --scope non-active-unexpired
   ```

   This expires only pending, superseded, and cancelled unconsumed tokens. It
   never changes active tokens, consumed timestamps, or a reservation fence.
6. Deploy a legacy image only after the intake residue, v2 delivery residue,
   terminal pending candidates, and non-active-unexpired count are all zero.
   Do not drop the migrations or new tables as part of rollback.

## Evidence to retain

Keep the Phase-A exit inventory, Phase-B active image inventory, legacy-residue
list/count/verify-zero output, audit IDs, exact image digests, migration
result, count/list/verify results, and any full-quiescence attestation with the
change record. A failure or missing proof is a rollout/rollback blocker, not an
operator judgment call.
