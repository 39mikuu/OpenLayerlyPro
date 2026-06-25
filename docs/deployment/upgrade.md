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

## 3. Stage the New Version Without Starting Migrations

The S3 concurrency migration adds a partial unique index that permits at most one
`pending_review` or `pending_payment` row for each `(user_id, tier_id)`. The migration first
checks existing data and fails with the conflicting user, tier, and row count. It never deletes
or silently rewrites financial records.

Obtain the new remediation tool before stopping the old application, but do not start the new
application yet. Starting the normal app entrypoint would run migrations immediately.

For a source checkout deployment, update the checkout and build only the new app image:

```bash
git pull --ff-only
docker compose build app
```

`docker compose build app` creates the image containing
`/app/scripts/dedupe-pending-payments.mjs`; it does not run the image or its entrypoint.

For an image-based deployment, update the Compose image reference to the new immutable tag and
pull it without starting a container:

```bash
docker compose pull app
```

Do not run `docker compose up` yet.

## 4. Stop Payment Writes and Resolve Duplicate Pending Payments

Stop every old application replica before remediation so no old process can create another
pending payment between cleanup and index creation. A maintenance mode is acceptable only when
it blocks all payment creation and resubmission writes.

```bash
docker compose stop app
```

Keep PostgreSQL running. Use the staged new image with an overridden entrypoint, which avoids the
normal automatic migration. Report conflicts first:

```bash
docker compose run --rm --no-deps --entrypoint node app \
  /app/scripts/dedupe-pending-payments.mjs
```

The report command exits with status `2` while conflicts exist. For each conflict, review the
listed request IDs and explicitly choose the request that remains pending. Preview the change:

```bash
docker compose run --rm --no-deps --entrypoint node app \
  /app/scripts/dedupe-pending-payments.mjs \
  --keep <request-id> --resolve cancelled --dry-run
```

Apply only after an existing administrator has reviewed the payment evidence and chosen the
outcome:

```bash
docker compose run --rm --no-deps --entrypoint node app \
  /app/scripts/dedupe-pending-payments.mjs \
  --keep <request-id> --resolve cancelled --apply \
  --actor-id <admin-user-id> --reason "Resolve duplicate pending requests before upgrade"
```

`--resolve rejected` is also supported. The tool verifies that `--actor-id` belongs to an
existing administrator in the same transaction as the changes. It is idempotent, updates rather
than deletes the other pending rows, writes an audit event for every changed request, and prints
a modification summary.

Run the report again immediately before migrating. Do not proceed until it exits with status `0`
and reports no conflicts:

```bash
docker compose run --rm --no-deps --entrypoint node app \
  /app/scripts/dedupe-pending-payments.mjs
```

## 5. Run the Migration and Start the New Version

With all old application replicas still stopped, run the migration from the staged new image:

```bash
docker compose run --rm --no-deps --entrypoint node app /app/dist/migrate.mjs
```

Start the new application only after the migration succeeds:

```bash
docker compose up -d app
```

The normal application entrypoint reruns the forward-only migration idempotently before starting
the server. If migration fails, the application container exits instead of serving traffic.
Keep the pre-upgrade backup until the migration and application checks are complete.

## 6. Verify the Upgrade

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

## 7. Failure and Rollback

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
