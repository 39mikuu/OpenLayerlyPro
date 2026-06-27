# Backup and Restore

> **Current runtime baseline:** the commands in this document describe the existing v1 archive/restore tooling. They do not yet implement S7 #87 archive checksums, legacy schema probing, restored-task neutralization, mandatory file-safety remediation during restore, DB↔storage convergence, or DB-aware storage-mode detection. Do not treat this baseline procedure as the final v1.0 recovery guarantee. The v1.0 release gate is [the v1.0 acceptance checklist](../release-v1.0-checklist.md).

OpenLayerlyPro data is not recoverable from the PostgreSQL dump alone. A recovery set must account for:

- PostgreSQL database;
- every local `uploads` object still referenced by `files.storage_driver='local'`;
- `/app/secrets/config-encryption-key` or the externally managed equivalent;
- `SESSION_SECRET` when seamless session/in-flight login-task recovery is required;
- every S3/R2 object still referenced by the database, protected through provider versions or snapshots.

The config encryption key decrypts admin-managed settings. `SESSION_SECRET` is a separate secret: losing or rotating it invalidates sessions and can make in-flight encrypted login-code tasks undecryptable. The standard archive contains the file-backed config key, not `SESSION_SECRET` or externally managed secrets.

## Requirements

Run scripts from the repository directory containing `docker-compose.yml` and `.env`. The target Compose project must use the supplied service names unless the scripts are explicitly adapted.

Required host tools:

- Docker Engine;
- Docker Compose v2;
- POSIX `sh`;
- `tar`, `mktemp`, and `curl`.

The scripts honor `COMPOSE_PROJECT_NAME`.

## Create a Baseline Backup

```bash
./scripts/backup.sh
```

The default output directory is `./backups`; another directory may be supplied:

```bash
./scripts/backup.sh /srv/backups/openlayerly
```

The current archive is named like:

```text
openlayerly-backup-20260619-052110.tar.gz
```

Current v1 archive members:

```text
db.sql
manifest.env
secrets/config-encryption-key
uploads/                         # included only when container env STORAGE_DRIVER resolves to local
UPLOADS_SKIPPED_S3               # written only when container env STORAGE_DRIVER resolves to s3
```

The script uses restrictive permissions and fails if the database dump, config key, env-based storage detection, selected upload copy, or archive creation fails. It does not print database passwords or key contents. A successful exit does **not** prove that the selected storage mode matches the effective DB-backed Storage configuration or that mixed-driver history is complete.

### External Config Key

When `CONFIG_ENCRYPTION_KEY` is supplied directly, `backup.sh` refuses to describe the archive as a complete recovery set because that value is outside the Docker volume. Preserve the exact value in the deployment secret manager, or migrate to the file-backed key before relying on the single-archive workflow.

### Storage Detection Limitation

The current `backup.sh` reads only `STORAGE_DRIVER` from the app container environment. Runtime uploads instead resolve Storage as DB override > env fallback, and historical local/S3 files can coexist after a driver switch.

Before relying on a baseline archive:

1. inspect the effective Storage configuration in the admin settings and compare it with the app container's `STORAGE_DRIVER` env fallback;
2. query or otherwise inventory file rows by `storage_driver`;
3. if any local rows exist, preserve the uploads volume even when the env fallback is `s3`;
4. if any S3 rows exist, preserve the matching bucket/version recovery point even when the env fallback is `local`;
5. record the comparison and restore a sample in an isolated project.

A DB override mismatch or mixed-driver history means `backup.sh` alone is not a complete recovery set. S7 #87 must replace this ambiguity with fail-safe manifest/inventory behavior; until then, operators must collect the missing storage side explicitly.

### Local Storage Consistency

When the script selects local mode from the container env, it performs a database dump and then copies local uploads. Writes during that interval can create a DB↔storage time gap. For the safest current baseline backup, stop the app or use a maintenance window that blocks writes until the archive and any separately collected storage data are complete.

S7 #87 will retain the practical hot-backup option but add manifest/checksum metadata and mandatory pre-start convergence; until then, operators must understand this residual.

### S3 / R2

When the container env resolves to `s3`, the archive contains DB + config key and adds `UPLOADS_SKIPPED_S3`; it does not copy bucket objects. The marker reflects the env fallback, not a verified DB-effective mode or object inventory. Enable versioning/snapshots/provider backup and record a recovery point close to the DB backup. Restoring DB rows cannot recreate deleted objects.

## Restore the Current Baseline Archive

> Restore is destructive. It replaces the target project's database, file-backed config key, and local uploads when present.

Interactive:

```bash
./scripts/restore.sh ./backups/openlayerly-backup-20260619-052110.tar.gz
```

Reviewed automation:

```bash
./scripts/restore.sh ./backups/openlayerly-backup-20260619-052110.tar.gz --yes
```

The **current** restore script:

1. rejects unsafe archive paths;
2. starts and waits for PostgreSQL;
3. stops the app and recreates the target database;
4. imports `db.sql` with `ON_ERROR_STOP=1`;
5. restores the file-backed config encryption key;
6. replaces local uploads when `uploads/` is present, or reports the env-derived S3 marker;
7. starts the app, whose entrypoint runs forward migrations;
8. polls `/api/ready`.

This baseline sequence does **not** yet perform the S7 pre-start pipeline. In particular, it does not guarantee that restored task leases/dedupe keys are safe to replay, that old image rows have passed the mandatory S1a backfill, that the archive captured every local/S3 object referenced by the restored DB, or that every DB file reference matches storage before the dispatcher starts.

For recovery work before #87 lands, prefer an isolated project, keep the production app stopped, review the imported data, run the documented one-off migration/file-safety steps where applicable, restore every separately protected local/S3 component, and do not expose the restored app until file/task/payment consistency has been assessed.

The script refuses a target that sets `CONFIG_ENCRYPTION_KEY` directly because the env value would override the restored file. Restore the matching external key through the secret manager or remove the override before retrying.

## S7 Target Restore Sequence (Not Yet Implemented)

Issue #87 must implement and test this sequence before v1.0 release:

```text
validate archive / checksum
→ v2 manifest compatibility check, or v1 isolated temporary-DB schema probe
→ import official DB and restore matching secrets/storage recovery point
→ one-off forward migrator
→ pre-scan missing referenced objects and quarantine them
→ mandatory files-backfill.mjs --apply
→ transactionally neutralize/re-arm tasks and payment-provider events
→ one-off DB↔storage convergence
→ start normal app/dispatcher
→ /api/ready and recovery report checks
```

Key invariants:

- compatibility must pass before the official DB is dropped;
- all restored `storage.delete_object` rows, including terminal rows, are removed so stale dedupe keys cannot block convergence;
- provider-event rows and dispatch tasks are restored as a pair;
- missing objects become quarantine/410, not storage 500;
- only convergence may re-enqueue deletion for confirmed orphans;
- any migration/backfill/neutralization/convergence error prevents normal app startup.

## Restore to an Independent Project

Use a separate Compose project for drills:

```bash
docker compose -p ams_restore_test build app
COMPOSE_PROJECT_NAME=ams_restore_test \
  READY_URL=http://localhost:3000/api/ready \
  ./scripts/restore.sh ./backups/openlayerly-backup-20260619-052110.tar.gz --yes
```

Only one project can bind host port 3000 with the default Compose file. Stop the source app or use an override with another loopback-only host port and matching `READY_URL`.

## Version Boundary

The current baseline only supports restoring into the same application version or a newer compatible release line. It relies on forward migrations at startup and cannot safely restore a newer DB into older application code.

S7 #87 will make the check explicit:

- v2 archives carry a migration identity and must be an exact same-order/hash prefix of the target journal;
- v1 archives are imported into an isolated temporary DB for Drizzle migration-history comparison;
- confirmed newer/divergent history is rejected;
- unknown v1 history fails closed unless an explicit legacy override is used, and that override cannot bypass confirmed incompatibility.

## Historical Clean-Environment Drill

A baseline drill passed on **2026-06-19** from commit `599a8d7` with PostgreSQL 16. It recovered one post, one membership, one local upload marker, and one encrypted SMTP group into a clean Compose project; `/api/ready` passed and the encrypted group was readable.

That drill validates the original issue #11 archive mechanics only. It predates subscriptions, S1a/S1b task semantics, S5 delivery ledger, DB-backed Storage overrides, mixed-driver history, and the S7 consistency model, so it is not sufficient evidence for v1.0. #87/#88 require a new drill covering tasks, provider events, file remediation, local/S3 drift, checksums and legacy schema compatibility.

## Cleanup After a Drill

```bash
docker compose -p ams_restore_test down -v
```

Never run `down -v` against production unless its data has already been safely recovered elsewhere.
