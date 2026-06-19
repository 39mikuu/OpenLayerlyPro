# Upgrade

This procedure covers upgrades within the current OpenLayerlyPro release line. Historical-version upgrade testing and downgrade migrations are not supported.

## 1. Review the Release

Before changing the running stack:

- read `CHANGELOG.md` and release notes;
- compare `.env.example` with the deployment's `.env`;
- confirm sufficient disk space for an image build and a complete backup;
- confirm `/api/ready` currently returns 200.

## 2. Create a Pre-Upgrade Backup

Always create and retain a complete archive immediately before upgrading:

```bash
./scripts/backup.sh /srv/backups/openlayerly
```

Do not proceed unless the command exits successfully. The archive contains the PostgreSQL dump, config encryption key, and local uploads when `STORAGE_DRIVER=local`.

For `STORAGE_DRIVER=s3`, the archive contains the database and encryption key only. Confirm bucket versioning, provider snapshots, or another tested object-storage backup before upgrading.

Record the exact archive path and the current Git commit or image tag:

```bash
git rev-parse HEAD
```

## 3. Pull and Deploy the New Version

Source checkout deployment:

```bash
git pull --ff-only
docker compose up -d --build
```

Image-based deployments should pull the new immutable image tag first, update the Compose image reference, and then run:

```bash
docker compose up -d
```

The application entrypoint runs database migrations before starting the server. Migrations are forward-only. If migration fails, the application container exits instead of serving traffic.

## 4. Verify the Upgrade

Inspect startup and migration logs:

```bash
docker compose logs --tail=200 app
```

Check liveness and readiness:

```bash
curl --fail --show-error http://localhost:3000/api/health
curl --fail --show-error http://localhost:3000/api/ready
```

`/api/ready` must return 200 with database, config, and encryption-key checks set to `true`.

Also sample the operational paths relevant to the deployment:

- admin login and settings read;
- published post access;
- membership access;
- one local-file download, or one S3/R2 signed download;
- mail configuration visibility without exposing its password.

## 5. Failure and Rollback

Do not attempt to reverse a database migration manually. Application code rollback alone is unsafe after a forward schema migration.

Rollback requires:

- the pre-upgrade archive created by `backup.sh`;
- the previous application image or source tag;
- the object-storage recovery point when using S3/R2.

Procedure:

1. stop the failed application;
2. check out or configure the previous application version;
3. build or pull that version's image;
4. restore the pre-upgrade archive with `restore.sh`;
5. restore the matching S3/R2 bucket state when required;
6. verify `/api/ready` and sample application data.

Example:

```bash
git checkout <previous-tag>
docker compose build app
./scripts/restore.sh /srv/backups/openlayerly/<pre-upgrade-archive>.tar.gz
```

The restore prompt explicitly warns that it replaces the target database, key, and local uploads. Use `--yes` only in a reviewed recovery command.

## Operational Notes

- Keep the pre-upgrade archive until the new version has passed readiness and application-level sampling.
- Store archives outside the application host or copy them off-host after creation.
- Encrypt backup storage and restrict access because archives contain database data, uploaded files, and the config encryption key.
- Test restore regularly; a backup job that has never been restored is not a verified recovery plan.
