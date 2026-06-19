# Backup and Restore

OpenLayerlyPro data is not recoverable from the PostgreSQL dump alone. A complete backup must keep these items together:

- PostgreSQL database
- local `uploads` volume when `STORAGE_DRIVER=local`
- `/app/secrets/config-encryption-key` from the `secrets` volume

The encryption key is required to decrypt admin-managed SMTP, storage, Turnstile, upload, and translation settings. Losing it while retaining the database still leaves those settings unreadable.

## Requirements

Run the scripts from the repository directory that contains `docker-compose.yml` and `.env`. The target Compose project must use the same service names (`app` and `postgres`) as the supplied deployment.

Required host tools:

- Docker Engine
- Docker Compose v2 (`docker compose`)
- POSIX `sh`
- `tar`, `mktemp`, and `curl`

The scripts honor `COMPOSE_PROJECT_NAME`, so the same commands can target an explicitly named Compose project.

## Create a Backup

```bash
./scripts/backup.sh
```

The default output directory is `./backups`. A different directory may be supplied:

```bash
./scripts/backup.sh /srv/backups/openlayerly
```

The script creates one permission-restricted archive named like:

```text
openlayerly-backup-20260619-052110.tar.gz
```

The archive contains:

```text
db.sql
manifest.env
secrets/config-encryption-key
uploads/                         # local storage only
UPLOADS_SKIPPED_S3               # S3/R2 only, instead of uploads/
```

The script does not print database passwords or encryption-key contents. It exits non-zero when the database dump, encryption key, storage-driver detection, upload copy, or archive creation fails.

The single-archive workflow requires the standard file-backed encryption key. When `CONFIG_ENCRYPTION_KEY` is set directly, `backup.sh` refuses to continue because the environment value is managed outside the Docker volume. Preserve that value in the deployment's secret manager, or migrate to the file-backed key before relying on this archive as the complete recovery set.

### Local Storage

With `STORAGE_DRIVER=local`, the archive includes the complete `/app/uploads` directory. Keep the archive encrypted at rest because it can contain member files and payment proofs.

### S3 / R2 Storage

With `STORAGE_DRIVER=s3`, the script backs up the database and encryption key but intentionally skips the local uploads volume and adds `UPLOADS_SKIPPED_S3` to the archive.

The object-storage bucket remains an independent backup responsibility. Enable bucket versioning or provider snapshots and test object recovery separately. Database rows reference object keys; restoring the database cannot recreate deleted bucket objects.

## Restore an Archive

> Restore is destructive. It replaces the target Compose project's database, file-backed encryption key, and local uploads when present.

Interactive restore:

```bash
./scripts/restore.sh ./backups/openlayerly-backup-20260619-052110.tar.gz
```

The operator must type `RESTORE` before any data is replaced. For a reviewed automation or recovery run, bypass the prompt explicitly:

```bash
./scripts/restore.sh ./backups/openlayerly-backup-20260619-052110.tar.gz --yes
```

The restore script:

1. rejects archive paths containing absolute paths or `..` traversal;
2. starts and waits for PostgreSQL;
3. stops the application and recreates the target database;
4. restores `db.sql` with `ON_ERROR_STOP=1`;
5. restores the config encryption key;
6. replaces local uploads, or reports the S3/R2 marker;
7. starts the application, allowing the entrypoint to run forward migrations;
8. polls `GET /api/ready` until it returns 200 or the restore times out.

The standard Docker deployment uses the file-backed key. If the target sets `CONFIG_ENCRYPTION_KEY` directly, `restore.sh` refuses to continue because that environment value would override the restored key file. Remove the override or restore the matching externally managed key before retrying.

### Restore to an Independent Project

Use a separate Compose project for drills or migration validation:

```bash
docker compose -p ams_restore_test build app
COMPOSE_PROJECT_NAME=ams_restore_test \
  READY_URL=http://localhost:3000/api/ready \
  ./scripts/restore.sh ./backups/openlayerly-backup-20260619-052110.tar.gz --yes
```

Only one project can bind host port `3000` at a time with the default Compose file. Stop the source app first, or use a temporary Compose override that maps the test app to another host port and set `READY_URL` accordingly.

### Version Boundary

Restore archives into the same application version or a newer version on the current release line. Application startup runs forward migrations automatically. Restoring a newer database into older application code or testing historical-version upgrades is outside this procedure.

## Verified Clean-Environment Restore Drill

A full drill was executed on **2026-06-19** from `main` commit `599a8d7` using Docker Engine `29.5.3`, Docker Compose `v5.1.4`, and the supplied PostgreSQL 16 service.

The source dataset contained:

- one published post;
- one membership;
- one local upload marker;
- one `smtp` configuration group written and immediately read through the project's encrypted config store.

The final archive was created with:

```bash
COMPOSE_PROJECT_NAME=ams_restore_test \
  ./scripts/backup.sh /tmp/openlayerly-issue11-final-backup
```

Before the final restore, `ams_restore_verify` had no containers or named volumes. The application image was built, the source app was stopped to release port 3000, and the archive was restored into the new project:

```bash
docker compose -p ams_restore_verify build app

COMPOSE_PROJECT_NAME=ams_restore_verify \
  READY_URL=http://localhost:3000/api/ready \
  ./scripts/restore.sh \
    /tmp/openlayerly-issue11-final-backup/openlayerly-backup-20260619-052110.tar.gz \
    --yes
```

Observed restore output included:

```text
Replacing PostgreSQL database...
Restoring config encryption key file...
Replacing local uploads...
Starting application and applying forward migrations...
Ready check passed: {"ok":true,"status":"ready","checks":{"database":true,"config":true,"encryptionKey":true}}
Restore completed from: /tmp/openlayerly-issue11-final-backup/openlayerly-backup-20260619-052110.tar.gz
```

Post-restore sampling returned:

```text
published_posts=1
memberships=1
encrypted_groups=smtp
upload_marker=present
encrypted_config_readable=smtp.restore.invalid
```

The encrypted-config check was read-only on the restored target: it called the project's `getStoredGroup("smtp")` without rewriting the row. Successful decryption therefore verifies that the database ciphertext and restored encryption key match.

Result: **PASS**. Database data, local uploads, the encryption key, application readiness, and encrypted admin configuration were all recovered in a clean Compose project.

## Cleanup After a Drill

After recording the results, remove the isolated drill stack and its volumes:

```bash
docker compose -p ams_restore_verify down -v
```

Never run `down -v` against the production project unless the production data has already been safely recovered elsewhere.
