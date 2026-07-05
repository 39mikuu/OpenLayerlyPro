# Backup and Restore

OpenLayerlyPro data is not recoverable from the PostgreSQL dump alone. A recovery set must account for:

- PostgreSQL database;
- every local `uploads` object still referenced by `files.storage_driver='local'`;
- `/app/secrets/config-encryption-key` or the externally managed equivalent;
- `/app/secrets/session-secret`, or the exact externally managed `SESSION_SECRET`;
- every S3/R2 object still referenced by the database, protected through provider versions or snapshots.

The config encryption key decrypts admin-managed settings. `SESSION_SECRET` is a separate
secret: losing or rotating it invalidates sessions and can make in-flight encrypted
login-code tasks undecryptable. New archives include a file-backed session secret.
Externally managed values are never archived; only a SHA-256 fingerprint is recorded.

## Requirements

Run scripts from the repository directory containing `docker-compose.yml` and `.env`. The target Compose project must use the supplied service names unless the scripts are explicitly adapted.

Required host tools:

- Docker Engine;
- Docker Compose v2;
- POSIX `sh`;
- `tar`, `mktemp`, `curl`, and `sha256sum`;
- Node.js on the host for `backup.sh` migration/manifest and payload-path validation helpers.

The scripts honor `COMPOSE_PROJECT_NAME`.

## Create a Backup

Hot backup (the app remains online):

```bash
./scripts/backup.sh
```

The default output directory is `./backups`; another directory may be supplied:

```bash
./scripts/backup.sh /srv/backups/openlayerly
```

For the strong-consistency path, let the script stop the normal app/dispatcher before `pg_dump`, keep it stopped through config-key and local-upload capture, and restart it immediately after the recovery set has been copied into the private workspace:

```bash
./scripts/backup.sh --stop-app /srv/backups/openlayerly
```

`--stop-app` resolves the app environment and volume paths through one-off containers, so it also works when the normal app container is already stopped. It inspects every existing app-service container, stops the whole service even when a container is currently `restarting`, and records only containers that were active (`running`, `restarting`, or `paused`) as restart targets. Exit/signal cleanup restarts those exact containers; intentionally stopped or merely created containers remain stopped.

New archives use `FORMAT_VERSION=3` and are named like:

```text
openlayerly-backup-20260627-134500.tar.gz
```

Archive members:

```text
db.sql
manifest.env
checksums.sha256
secrets/config-encryption-key
secrets/session-secret            # only for SESSION_SECRET_SOURCE=file
uploads/                         # included only when container env STORAGE_DRIVER resolves to local
UPLOADS_SKIPPED_S3               # written only when container env STORAGE_DRIVER resolves to s3
```

`manifest.env` records image-authoritative runtime provenance, storage and migration
identity, the config-key path and fingerprint, capture consistency mode, and
`SESSION_SECRET_SOURCE`. `RUNTIME_APP_VERSION`, `RUNTIME_SOURCE_COMMIT`,
`RUNTIME_IMAGE_ID`, and `BUILD_TIMESTAMP` are read from the app image's OCI labels and
image ID, not from runtime/container environment overrides.
`BACKUP_TOOL_COMMIT` and `BACKUP_TOOL_SCRIPT_SHA256` describe the checkout and script
that produced the archive; they are deliberately separate from the runtime image fields.
`APP_VERSION` is retained for compatibility and mirrors `RUNTIME_APP_VERSION` in v3.
File-backed archives record the container path and `secrets/session-secret`; external
sources record only `SESSION_SECRET_SHA256`.

For `FORMAT_VERSION=3`, restore treats the runtime provenance, config-key fingerprint,
and `CONFIG_ENCRYPTION_KEY_FORMAT` fields as required manifest fields. Missing,
duplicated, empty, control-character-bearing, or malformed values fail before any
destructive restore step. Legacy v1/v2 archives keep their compatibility defaults and
warning path. `CONFIG_ENCRYPTION_KEY_FORMAT` is derived from the trimmed archived key
material: keys beginning with `cek1:` are `v1`; any other non-empty key is `legacy`.

`CONFIG_ENCRYPTION_KEY_SHA256` is the SHA-256 of the archived config key after trimming
leading/trailing whitespace, matching the runtime readers' `.trim()` semantics. Restore
checks this fingerprint and the derived `CONFIG_ENCRYPTION_KEY_FORMAT` before the
destructive boundary. The fingerprint proves the archived key file still matches the
manifest; the existing decrypt probe separately proves that key can decrypt archived
encrypted settings. A whitespace-only archived config key fails closed.

`checksums.sha256` covers every regular-file payload member except the root `./checksums.sha256` manifest itself (nested upload files named `checksums.sha256` remain covered). On v2/v3 archives, `restore.sh` rejects symlinks and special files, verifies checksums, and then enforces a strict bijection: every extracted regular-file payload must appear exactly once in the manifest, and every manifest entry must have a matching payload file. The parser reads the fixed-width GNU checksum prefix, so ordinary filenames containing spaces are preserved exactly.

To keep that manifest unambiguous and portable, `backup.sh` rejects path components containing backslashes, ASCII control characters (`U+0000`–`U+001F`), or `DEL` (`U+007F`) before publishing an archive. Ordinary spaces and non-ASCII Unicode names remain supported. The same validation runs on the live local upload tree before copying and on the assembled workspace before checksum/tar creation.

Legacy `FORMAT_VERSION=1` archives remain restorable through the compatibility path below, but they have no checksum protection and emit an explicit warning. `FORMAT_VERSION=1` and `FORMAT_VERSION=2` archives also warn that they predate image-authoritative provenance; restore may show `unknown` or host-derived runtime fields for those archives.

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

The default mode performs `pg_dump` and then copies local uploads while the app remains online. Writes during that interval can create a DB↔storage time gap.

Use the explicit strong-consistency mode for the safest local recovery set:

```bash
./scripts/backup.sh --stop-app /srv/backups/openlayerly
```

The script first resolves and validates the app environment/volume paths using one-off containers, records the initial state of every app-service container, then issues `compose stop app` for every existing service container. Afterward it fails closed if any app container is still `running`, `restarting`, or `paused`. It captures the database, config key, and local uploads while writes and the task dispatcher are stopped. After those inputs are copied into the private backup workspace, it restarts only the containers that were active before the stop; containers that were already stopped or merely created remain stopped. Stop failures are fatal; restart failures make the command fail and are retried by cleanup.

### S3 / R2

When the container env resolves to `s3`, the archive contains DB + config key and adds `UPLOADS_SKIPPED_S3`; it does not copy bucket objects. Enable versioning/snapshots/provider backup and record a recovery point close to the DB backup. Restoring DB rows cannot recreate deleted objects.

`--stop-app` makes the database/config capture application-consistent, but it does not snapshot the provider bucket. Coordinate the bucket recovery point separately.

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
→ verify v2/v3 checksums and manifest/payload bijection (v1 warns and continues)
→ warn for v1/v2 image-provenance gaps
→ strictly validate required v3 provenance and config-key fingerprint/format fields
→ verify v3 CONFIG_ENCRYPTION_KEY_SHA256 and CONFIG_ENCRYPTION_KEY_FORMAT against the archived trimmed key material
→ warn, never reject, on archive-vs-target image version/commit/image mismatches
→ v2/v3 manifest compatibility check, or v1 isolated temporary-DB schema probe
→ validate external SESSION_SECRET or restore the checksummed file-backed secret
→ pre-destructive archive config-key decrypt probe against archived app_settings data
→ import official DB and restore config key to the target CONFIG_ENCRYPTION_KEY_FILE path
→ one-off forward migrator (dist/migrate.mjs)
→ pre-scan missing referenced objects and quarantine them (dist/restore-pre-scan.mjs)
→ mandatory files-backfill.mjs --apply
→ transactionally neutralize/re-arm tasks and payment-provider events (dist/restore-neutralize.mjs)
→ one-off DB↔storage convergence (dist/restore-converge.mjs)
→ post-restore config encryption key decrypt probe (dist/restore-config-key-probe.mjs)
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
- v3 `CONFIG_ENCRYPTION_KEY_SHA256` and `CONFIG_ENCRYPTION_KEY_FORMAT` are checked against the archived key file before the official database, secrets, or uploads are replaced. This is complementary to the decrypt probe: fingerprint mismatch means archive integrity failure; decrypt failure means the archived key cannot read archived ciphertext;
- archive-vs-target runtime app version, source commit, and image ID mismatches are warnings only. Migration identity remains the hard compatibility gate. If an existing target app container sets `APP_VERSION`, `SOURCE_COMMIT`, or `BUILD_TIMESTAMP` to values that conflict with non-`unknown` image labels, backup/restore fails loudly because the container environment is overriding the image build identity;
- before replacing the official database, restore extracts archived `app_settings` rows into an isolated scratch database and verifies the archived config key can decrypt every encrypted setting. Missing or empty `app_settings` data logs an explicit skip. After convergence, restore runs the same probe against the restored database to verify the active runtime key and fully restored state before app startup;
- S3 convergence enumerates only controlled application key namespaces (`avatars/`, `payment-qr/`, `payment-proof/`, `content/`, `legacy/`, `remediated/`). Override with comma-separated `RESTORE_S3_ENUM_PREFIXES` when needed;
- incomplete storage enumeration (truncated listing or converge errors) exits non-zero and prevents app startup;
- `CONFIG_ENCRYPTION_KEY_FILE` must be a canonical absolute file path under `/app/secrets` (no `..`, no directory path). Restore validates the target path before dropping the official database;
- `UPLOAD_DIR` is read from the target container at backup/restore time and must stay under `/app/uploads`. Local upload backup and restore use that resolved path for both `compose cp` directions;
- S3 `files.bucket = NULL` rows are matched against the configured bucket during convergence so referenced objects are not misclassified as orphans.

The target image must contain and be able to execute:

```text
dist/migrate.mjs
dist/files-backfill.mjs
dist/admin-reset.mjs
dist/restore-pre-scan.mjs
dist/restore-neutralize.mjs
dist/restore-converge.mjs
dist/restore-schema-check.mjs
dist/restore-config-key-probe.mjs
```

The script refuses a target that sets `CONFIG_ENCRYPTION_KEY` directly because the env value would override the restored file. Restore the matching external key through the secret manager or remove the override before retrying.

### SESSION_SECRET semantics

File-backed secrets are checksummed, restored as a regular file with mode `0600`, and
validated before app startup. External secrets must be supplied explicitly and match the
manifest SHA-256 fingerprint. Historical archives have no fingerprint or secret payload:
restore requires an explicit, strong `SESSION_SECRET` (non-empty after trimming, not
`change-me`, at least 32 characters). This is validated before any destructive database or
key work, so a weak or missing value aborts while the target database is still intact, and
warns that continuity cannot be proven. It never lets entrypoint silently generate a
replacement during restore.

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

- v2/v3 archives carry migration identity and must be a same-order/hash prefix of the target image journal;
- v3 archives additionally carry image-authoritative provenance and a trimmed config-key fingerprint. These fields improve auditability and archive integrity checks, but do not replace migration identity as the compatibility boundary;
- runtime app version, source commit, build timestamp, and image ID mismatches warn during restore and are surfaced in the confirmation output; they never reject a restore by themselves;
- v1 archives are imported into an isolated temporary database for Drizzle migration-history comparison before the official DB is replaced;
- confirmed newer/divergent history is rejected;
- unknown v1 history fails closed unless `--allow-legacy-v1-unknown-schema` is supplied, and that override cannot bypass confirmed incompatibility.

## Build Provenance

Production builds should pass the same identity fields that backup records:

```bash
docker build \
  --build-arg APP_VERSION="$(node -p 'require("./package.json").version')" \
  --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  --build-arg BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t openlayerlypro:release .
```

The Dockerfile persists these values in `/app/build-info.json`, image environment variables,
and OCI labels:
`org.opencontainers.image.version`, `org.opencontainers.image.revision`,
`org.opencontainers.image.created`, and `org.opencontainers.image.source`. The app reads
`/app/build-info.json` first and only falls back to environment variables outside the image.
Backup and restore read the image labels and image ID. Plain `docker build .` still works
with `dev`/`unknown` fallbacks, which are intentionally distinguishable from release images.

## Isolated E2E Drills

Local nested-upload drill (explicit backup stop/restart success and failure cleanup, referenced filename containing a space, membership, encrypted config decrypt, provider re-arm, email neutralization, quarantine 410):

```bash
./scripts/test-restore-e2e.sh
```

MinIO/S3 drill (bucket mirror, missing-object quarantine, orphan cleanup enqueue, truncated enumeration fail-closed):

```bash
./scripts/test-restore-s3-e2e.sh
```

Checksum gate on a produced archive:

```bash
./scripts/test-restore-checksum-gate.sh /tmp/openlayerlypro-s7-e2e-backups/openlayerly-backup-*.tar.gz
```

## Cleanup After a Drill

```bash
docker compose -p openlayerlypro_s7_drill down -v
docker compose -p openlayerlypro_s7_source down -v
docker compose -p openlayerlypro_s7_restore down -v
docker compose -p openlayerlypro_s7_s3_source down -v
docker compose -p openlayerlypro_s7_s3_restore down -v
```

Never run `down -v` against production unless its data has already been safely recovered elsewhere.
