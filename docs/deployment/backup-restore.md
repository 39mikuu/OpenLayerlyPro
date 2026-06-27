# Backup and Restore

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
- `tar`, `mktemp`, `curl`, and `sha256sum`;
- Node.js on the host for `backup.sh` migration/manifest helpers.

The scripts honor `COMPOSE_PROJECT_NAME`.

## Create a Backup

```bash
./scripts/backup.sh
```

The default output directory is `./backups`; another directory may be supplied:

```bash
./scripts/backup.sh /srv/backups/openlayerly
```

New archives use `FORMAT_VERSION=2` and are named like:

```text
openlayerly-backup-20260627-134500.tar.gz
```

Archive members:

```text
db.sql
manifest.env
checksums.sha256
secrets/config-encryption-key
uploads/                         # included only when container env STORAGE_DRIVER resolves to local
UPLOADS_SKIPPED_S3               # written only when container env STORAGE_DRIVER resolves to s3
```

`manifest.env` records `APP_VERSION`, `STORAGE_DRIVER`, `UPLOADS_INCLUDED`, migration identity (`LATEST_MIGRATION_HASH`, `MIGRATION_IDENTITIES_JSON`), the source container `CONFIG_ENCRYPTION_KEY_FILE` path at backup time, and a hot-backup window note (`pg_dump(T1)` then uploads `T2)`).

`checksums.sha256` covers every payload member except itself. On v2 archives, `restore.sh` verifies checksums and then enforces a strict bijection: every extracted payload file must appear exactly once in the manifest, and every manifest entry must have a matching payload file. Either mismatch aborts restore before any destructive step.

Legacy `FORMAT_VERSION=1` archives remain restorable through the compatibility path below, but they have no checksum protection and emit an explicit warning.

### External Config Key

When `CONFIG_ENCRYPTION_KEY` is supplied directly, `backup.sh` refuses to describe the archive as a complete recovery set because that value is outside the Docker volume. Preserve the exact value in the deployment secret manager, or migrate to the file-backed key before relying on the single-archive workflow.

### Storage Detection Limitation

`backup.sh` still reads only `STORAGE_DRIVER` from the app container environment. Runtime uploads resolve Storage as DB override > env fallback, and historical local/S3 files can coexist after a driver switch.

Before relying on an archive:

1. inspect the effective Storage configuration in the admin settings and compare it with the app container's `STORAGE_DRIVER` env fallback;
2. query or otherwise inventory file rows by `storage_driver`;
3. if any local rows exist, preserve the uploads volume even when the env fallback is `s3`;
4. if any S3 rows exist, preserve the matching bucket/version recovery point even when the env fallback is `local`;
5. record the comparison and restore a sample in an isolated project.

Mixed-driver history still requires operators to protect both sides explicitly. Restore convergence reconciles DB references against the recovered storage recovery point, but it cannot recreate objects that were never restored.

### Local Storage Consistency

When the script selects local mode from the container env, it performs a database dump and then copies local uploads. Writes during that interval can create a DB↔storage time gap. For the safest backup, stop the app or use a maintenance window that blocks writes until the archive and any separately collected storage data are complete.

### S3 / R2

When the container env resolves to `s3`, the archive contains DB + config key and adds `UPLOADS_SKIPPED_S3`; it does not copy bucket objects. Enable versioning/snapshots/provider backup and record a recovery point close to the DB backup. Restoring DB rows cannot recreate deleted objects.

## Restore

> Restore is destructive. It replaces the target project's database, file-backed config key, and local uploads when present.

Interactive:

```bash
./scripts/restore.sh ./backups/openlayerly-backup-20260627-134500.tar.gz
```

Reviewed automation:

```bash
./scripts/restore.sh ./backups/openlayerly-backup-20260627-134500.tar.gz --yes
```

Legacy v1 archives with unreadable migration history require an explicit operator override:

```bash
./scripts/restore.sh ./backups/legacy-v1-archive.tar.gz --yes --allow-legacy-v1-unknown-schema
```

That flag only relaxes **unknown** v1 history. It cannot bypass confirmed newer/divergent migration histories.

### Hardened restore sequence

`restore.sh` keeps the app/dispatcher stopped until the full pipeline succeeds:

```text
validate archive paths
→ verify v2 checksums and manifest/payload bijection (v1 warns and continues)
→ v2 manifest compatibility check, or v1 isolated temporary-DB schema probe
→ import official DB and restore config key to the target CONFIG_ENCRYPTION_KEY_FILE path
→ one-off forward migrator (dist/migrate.mjs)
→ pre-scan missing referenced objects and quarantine them (dist/restore-pre-scan.mjs)
→ mandatory files-backfill.mjs --apply
→ transactionally neutralize/re-arm tasks and payment-provider events (dist/restore-neutralize.mjs)
→ one-off DB↔storage convergence (dist/restore-converge.mjs)
→ start normal app/dispatcher
→ /api/ready
```

Key invariants:

- compatibility must pass before the official DB is dropped;
- all restored `storage.delete_object` rows, including terminal rows, are removed so stale dedupe keys cannot block convergence;
- provider-event rows and dispatch tasks are restored as a pair;
- missing objects become quarantine/410, not storage 500;
- only convergence may re-enqueue deletion for confirmed orphans;
- any migrator/backfill/neutralization/convergence error prevents normal app startup;
- S3 convergence enumerates only controlled application key namespaces (`avatars/`, `payment-qr/`, `payment-proof/`, `content/`, `legacy/`, `remediated/`). Override with comma-separated `RESTORE_S3_ENUM_PREFIXES` when needed;
- incomplete storage enumeration (truncated listing or converge errors) exits non-zero and prevents app startup.

The target image must contain and be able to execute:

```text
dist/migrate.mjs
dist/files-backfill.mjs
dist/admin-reset.mjs
dist/restore-pre-scan.mjs
dist/restore-neutralize.mjs
dist/restore-converge.mjs
dist/restore-schema-check.mjs
```

The script refuses a target that sets `CONFIG_ENCRYPTION_KEY` directly because the env value would override the restored file. Restore the matching external key through the secret manager or remove the override before retrying.

### SESSION_SECRET semantics

`SESSION_SECRET` is not stored in the archive. Operators must back it up separately. Losing or rotating it invalidates sessions and can make in-flight encrypted login-code tasks undecryptable. Recovery remains possible, but all users must sign in again.

### Stripe residual risk

After restore, review payment/subscription/dispute state near the archive timestamp. Provider events are re-armed from the DB snapshot; reconcile runs afterward, but DB and live Stripe state are not atomically identical.

## Restore to an Independent Project

Use a separate Compose project for drills:

```bash
docker compose -p openlayerlypro_s7_drill build app
COMPOSE_PROJECT_NAME=openlayerlypro_s7_drill \
  READY_URL=http://localhost:3000/api/ready \
  ./scripts/restore.sh ./backups/openlayerly-backup-20260627-134500.tar.gz --yes
```

Only one project can bind host port 3000 with the default Compose file. Stop the source app or use an override with another loopback-only host port and matching `READY_URL`.

## Version Boundary

- v2 archives carry migration identity and must be a same-order/hash prefix of the target image journal;
- v1 archives are imported into an isolated temporary database for Drizzle migration-history comparison before the official DB is replaced;
- confirmed newer/divergent history is rejected;
- unknown v1 history fails closed unless `--allow-legacy-v1-unknown-schema` is supplied, and that override cannot bypass confirmed incompatibility.

## Cleanup After a Drill

```bash
docker compose -p openlayerlypro_s7_drill down -v
```

Never run `down -v` against production unless its data has already been safely recovered elsewhere.