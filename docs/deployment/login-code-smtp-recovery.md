# Login-code SMTP reservation recovery

This procedure applies only after migration `0041_login_smtp_reservation`.
An unclosed reservation blocks code verification and further requests for that email,
even after code expiry or task reclaim. A healthy send releases its own generation
after positive socket-close evidence. Process crashes, ambiguous teardown, or database
outages can intentionally leave a reservation behind. Task retry alone cannot clear it.

## Preconditions

1. Stop **all** app/worker instances that could own the SMTP connection, including stale
   deployments. Confirm the old processes have exited and their sockets are closed.
   If this cannot be proven, do not clear the reservation. A database lease is not proof.
2. Keep these workers stopped for the entire transaction. Use the normal authorized
   database operator connection; do not expose task payloads, emails, codes or challenges.
3. Identify the exact code ID and reservation UUID from a restricted query of
   `login_codes(id, smtp_reservation_token, smtp_reserved_at)`. Do not select payloads.
   Record the incident and evidence of process/socket termination outside public logs.

## Exact-generation recovery

In `psql`, set `code_id` and `generation` to the UUIDs for the one incident. The following
transaction preserves the code-before-task lock order and only fences an inactive lease.
If either UPDATE does not affect exactly one row, **ROLLBACK** and investigate; do not
substitute broader predicates. A still-valid lease must first expire while workers stay stopped.

```sql
BEGIN;
SELECT id FROM login_codes
WHERE id = :'code_id'::uuid AND smtp_reservation_token = :'generation'::uuid
FOR UPDATE;
UPDATE tasks SET status = 'dead', locked_at = NULL, locked_by = NULL,
  lease_until = NULL,
  updated_at = now(), last_error = 'SMTP reservation recovered by operator'
WHERE dedupe_key = 'auth-login-code-email:' || :'code_id'
  AND (status <> 'processing' OR locked_by IS NULL OR lease_until <= now());
UPDATE login_codes SET smtp_reservation_token = NULL, smtp_reserved_at = NULL
WHERE id = :'code_id'::uuid AND smtp_reservation_token = :'generation'::uuid
  AND EXISTS (SELECT 1 FROM tasks
    WHERE dedupe_key = 'auth-login-code-email:' || :'code_id'
      AND status = 'dead' AND locked_at IS NULL AND locked_by IS NULL
      AND lease_until IS NULL);
-- Only after checking both row counts and termination evidence:
COMMIT;
```

Restart workers only after the transaction commits. An unexpired code may be verified;
an expired code must be requested again. If retrying the dead delivery task is necessary,
use the existing administrator retry workflow: it rechecks code freshness and creates a
new reservation generation. Clearing the reservation is not evidence of delivery and
does not promise exactly-once SMTP. Never clear a replacement generation using a stale UUID.

For restoring backups containing reservations, keep the application stopped and apply
the same termination-evidence procedure before reopening login-code delivery. Restoring
a database alone cannot prove that sockets in the source deployment have closed.
The restore script checks for other live database clients and **any** non-null
`smtp_reservation_token` after migration, neutralization, convergence and the
config-key probe, before starting the app. Stop every source and target app/worker
owner, including other Compose projects or hosts, and prove their SMTP sockets closed
before the check; an empty database-session snapshot cannot rule out later reconnects.
If the check fails, the archive has already been imported and the app stays stopped. Do not
rerun the archive: that would bring the reservation back. After proving that all source
and target SMTP owners have exited and their sockets closed, recover every outstanding
generation with the transaction above. Close any other database client connections.
Then set the **same target** Compose project, file list, environment file and ready URL
used by restore (an inline `COMPOSE_PROJECT_NAME=... ./scripts/restore.sh` assignment
does not persist), run the check and start the app:

```bash
COMPOSE_PROJECT_NAME=your-restore-project
COMPOSE_FILE=docker-compose.yml:your-restore-overlay.yml
COMPOSE_ENV_FILE=.env
READY_URL=http://127.0.0.1:3000/api/ready
export COMPOSE_PROJECT_NAME COMPOSE_FILE
docker compose --env-file "$COMPOSE_ENV_FILE" run --rm --no-deps -T --entrypoint node app /app/dist/restore-login-code-smtp-check.mjs
docker compose --env-file "$COMPOSE_ENV_FILE" up -d --force-recreate app
curl -fsS "$READY_URL"
```

Replace every example value with the actual restore target, including additional
Compose overlays. If no overlay was used, set `COMPOSE_FILE=docker-compose.yml`.
Only start the app if the check exits successfully and all other owners remain
stopped. If it still fails, leave the app stopped and investigate remaining
connections, reservations or database access errors.
