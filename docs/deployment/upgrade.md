# Upgrade

> This procedure describes the current `main` upgrade path. It requires pending-payment remediation, a one-off forward migrator, and the mandatory file-safety backfill before the app starts. The merged S7 restore path adds archive integrity, schema probing, task neutralization, and DB↔storage convergence. The completed v1.1.0 release evidence is archived in [the v1.1.0 release notes](../releases/v1.1.0-release-notes.md).

The v1.0 acceptance path is tested from the `v0.1.0` tag. The unreleased v0.2
candidate and arbitrary historical commits are not supported upgrade sources.
Downgrade migrations are not supported.

## v1.0.0 to v1.1.0 Notes

Before upgrading a `v1.0.0` deployment to `v1.1.0`, create a complete recovery
point and keep the old app image/source, database/config/local archive, matching
S3/R2 recovery point, and external secrets until the upgraded deployment and an
isolated restore drill pass.

`v1.1.0` adds migrations `0021` through `0027` for task claim indexes, public
feed indexing, opt-in notification campaigns/deliveries/attempts/suppression,
G1 transactional email payload privacy, notification delivery fencing, and the
supporter wall. The normal app entrypoint reruns forward migrations
idempotently, but production upgrades should still stage the new image, stop
writes, and run the one-off migrator before starting the app.

Compare `.env.example` with the deployment's `.env`. New notification queue and
delivery controls include `TASK_TRANSACTIONAL_RESERVED_PER_BATCH`,
`TASK_NOTIFICATION_MIN_PER_BATCH`,
`TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH`,
`NOTIFICATION_EMAIL_DAILY_BUDGET`, `NOTIFICATION_EMAIL_PACING_PER_MINUTE`,
`NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE`,
`NOTIFICATION_DELIVERY_MAX_AGE_HOURS`, and
`NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS`.

Notification unsubscribe and suppression digest keys are separate from
`SESSION_SECRET`. Compose production starts may leave the current direct secret
values unset: the entrypoint defaults `NOTIFICATION_UNSUBSCRIBE_KEY_ID` and
`NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID` to `current` and creates persistent
`0600` files at `NOTIFICATION_UNSUBSCRIBE_SECRET_FILE` and
`NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE`. Non-Compose deployments must
provide direct `*_SECRET` values or readable regular files. Previous keys are
never auto-generated; configure `NOTIFICATION_UNSUBSCRIBE_PREVIOUS_*` and
`NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_*` only during explicit rotation and
retain them until old tokens/digests no longer need verification.

Since v1.2, fan Magic Link login uses a dedicated `MAGIC_LINK_*` keyring with
the same current+previous rotation semantics. Compose upgrades need no manual
step: the entrypoint defaults `MAGIC_LINK_KEY_ID` to `current` and creates a
persistent `0600` file at `MAGIC_LINK_SECRET_FILE`
(`/app/secrets/magic-link-secret` by default). Non-Compose deployments enable
the feature by providing `MAGIC_LINK_KEY_ID` plus `MAGIC_LINK_SECRET` or
`MAGIC_LINK_SECRET_FILE`; leaving them unset keeps the login page code-only.
Magic link tokens live for 15 minutes, so rotation only needs the previous key
retained briefly, and restores never require magic link key continuity.

Migration `0030_wp3_membership_entitlements` adds the non-null
`membership_tiers.entitlements` JSONB column with an empty-array default.
Existing tiers therefore keep their current sales and access behavior until an
administrator selects Core benefits. No data remediation or new secret is
required; unknown entitlement keys are rejected by writes and fail closed on
reads.

Administrative tier create and update API calls must now include a non-empty
`reason` field of at most 500 characters so the mutation and its audit record
can commit atomically.

Backups created by `v1.1.0` use manifest `FORMAT_VERSION=4` and record
notification key sources, key IDs, file paths when file-backed, and SHA-256
fingerprints. Restore validates notification key continuity before replacing the
production database. An archive containing WP2 notification data but lacking v4
notification-key manifest fields fails closed unless the compatibility probe
proves there is no notification continuity data to protect.

## 1. Review the Release

Before changing the running stack:

- read `CHANGELOG.md`, release notes, and any version-specific remediation notice;
- compare `.env.example` with the deployment's `.env`;
- confirm sufficient disk space for image build, database work, temporary remediated objects, and a complete backup;
- confirm `/api/ready` currently returns 200;
- record the current commit/image digest and target commit/image digest.

## 2. Create a Pre-Upgrade Recovery Point

Create and retain a complete archive immediately before upgrading:

```bash
./scripts/backup.sh /srv/backups/openlayerly
```

Do not proceed unless the command exits successfully. For local storage, the
archive contains PostgreSQL, file-backed config/session/notification secrets,
and uploads. Environment-managed `SESSION_SECRET` or notification secrets are
not archived; their fingerprints are recorded and the exact values must remain
in the operator's secret manager.

For S3/R2, record and verify a matching bucket version/snapshot/provider recovery point. The archive alone cannot restore object bytes.

Record the archive, current commit/image, and object-storage recovery point:

```bash
git rev-parse HEAD
```

Current archives use manifest format v4: v3's image-authoritative runtime
provenance, backup-tool provenance, and config-key fingerprint/format fields
plus notification unsubscribe/suppression key continuity fields, all validated
fail-closed before the production database is touched (see
[backup-restore](backup-restore.md)). v1/v2 archives remain supported only as
compatibility restore paths and warn that they predate image-authoritative
provenance; v3 archives predate WP2 notification key continuity. Use
`backup.sh --stop-app` when a self-consistent local snapshot is required, and
keep the old deployment intact until verification completes.

## 3. Stage the New Version Without Starting It

For source deployments:

```bash
git pull --ff-only
OPENLAYERLY_BUILD_VERSION="$(node -p 'require("./package.json").version')" \
OPENLAYERLY_BUILD_COMMIT="$(git rev-parse HEAD)" \
OPENLAYERLY_BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
docker compose build app
```

Pass these build identity variables inline for the release build. Do **not** persist them
in `.env`; stale values would bake a false identity into later images. Plain
`docker compose up -d --build` remains valid for non-release rebuilds and produces an
explicit `dev`/`dev`/`unknown` identity.

For image deployments, update to an immutable tag/digest and pull without starting:

```bash
docker compose pull app
```

Do not run `docker compose up` yet. The normal entrypoint runs migrations and starts the dispatcher, which is too early for the required pre-migration remediation/backfill sequence.

Existing env-managed deployments remain compatible. To switch from env to file, first write
the exact existing value to `SESSION_SECRET_FILE` with mode `0600`, then remove the env
override. Never let entrypoint generate a different value during this migration.

## 4. Stop Writes and Resolve Duplicate Pending Payments

Stop every old app replica. A maintenance mode is acceptable only if it blocks all payment creation, resubmission, admin grant, upload and content writes relevant to the migration.

```bash
docker compose stop app
```

Keep PostgreSQL running. Use the staged new image with an overridden entrypoint.

Report duplicate pending payment identities:

```bash
docker compose run --rm --no-deps --entrypoint node app \
  /app/scripts/dedupe-pending-payments.mjs
```

The report exits non-zero while conflicts exist. For each conflict, an administrator must choose the request that remains pending. Preview:

```bash
docker compose run --rm --no-deps --entrypoint node app \
  /app/scripts/dedupe-pending-payments.mjs \
  --keep <request-id> --resolve cancelled --dry-run
```

Apply only after reviewing payment evidence:

```bash
docker compose run --rm --no-deps --entrypoint node app \
  /app/scripts/dedupe-pending-payments.mjs \
  --keep <request-id> --resolve cancelled --apply \
  --actor-id <admin-user-id> --reason "Resolve duplicate pending requests before upgrade"
```

`--resolve rejected` is also supported. The tool validates the admin, updates rather than deletes financial rows, writes audit records, is idempotent, and prints a summary.

Run the report again immediately before migration. Do not proceed until it reports no conflicts.

## 5. Run the One-Off Migrator

With all old app replicas stopped:

```bash
docker compose run --rm --no-deps --entrypoint node app /app/dist/migrate.mjs
```

Do not rely on the normal app entrypoint for this step. The app must remain stopped while the next file-safety remediation runs.

### File reference integrity migration (0020)

This migration adds database-enforced integrity between `files` and every
table that references one (post covers, payment QR/proof images,
inline post files, and the three site branding settings). It aborts instead of
applying if it finds a pre-existing reference to a file that is missing,
quarantined, or has the wrong `purpose` for its usage — including the site
avatar/logo/icon settings, which previously had no `purpose` enforcement on
write and could reference e.g. a `content_image`-purpose file. If this
migration fails, an administrator must inspect and correct the offending
row(s) (reported in the error) before rerunning; it will not silently delete
or repair the data for you. It also acquires an exclusive lock across these
tables for the duration of its preflight check and schema changes (`NOWAIT`,
so it fails fast and is retried automatically rather than queuing), which is
why this step requires the application to be fully stopped beforehand.

This preflight check only guarantees a clean state at the moment the
migration runs. The very next step (file-safety remediation) can still mark
an already-referenced file as quarantined if it fails the stricter safety
scan — that's expected, not a regression: quarantine and file-reference
integrity are independent concerns, and the application has always refused
to serve quarantined file bytes regardless of whether the file is
referenced (`authorizeFileAccess` returns `410 fileQuarantined`). A
newly-quarantined referenced file means the referencing content (a post
cover, a QR code, etc.) will render without a valid image until an
administrator replaces or removes the reference — not data corruption or a
crash. Review the remediation preview's quarantine list with this in mind
before applying it.

## 6. Run Mandatory File-Safety Remediation

Preview first:

```bash
docker compose run --rm --no-deps --entrypoint node app /app/dist/files-backfill.mjs
```

Review the proposed remediations/quarantines, then apply:

```bash
docker compose run --rm --no-deps --entrypoint node app /app/dist/files-backfill.mjs --apply
```

The backfill:

- selects image-purpose rows below the current remediation version;
- server-detects and normalizes raster images into deterministic remediated object keys;
- atomically switches the DB row and queues deletion of the old object;
- quarantines unsafe SVG/HTML/non-raster bytes without serving them;
- is idempotent for rows already at the target version.

If the command fails, keep the app stopped. Investigate missing storage objects/configuration rather than bypassing the backfill.

## 7. Start and Verify the New Version

Only after remediation and migration succeed:

```bash
docker compose up -d app
```

The normal entrypoint reruns the forward migration idempotently and then starts the server/dispatcher. Inspect logs:

```bash
docker compose logs --tail=200 app
```

Check:

```bash
curl --fail --show-error http://localhost:3000/api/health
curl --fail --show-error http://localhost:3000/api/ready
```

Sample at least:

- admin login and encrypted settings;
- fan request-code/verify-code;
- published and member content;
- membership and payment/subscribe actions relevant to the deployment;
- one local or S3 file download and one video Range request;
- quarantined-file admin metadata without byte access;
- SMTP status and task/delivery views.

Keep the pre-upgrade archive, previous image/source, and S3 recovery point until these checks and the version-specific acceptance tests pass.

## 8. Security Headers and File Delivery

Application-streamed protected files already use strict isolation headers. S3 direct signed responses may depend on object metadata/CDN behavior.

The application sets document-level per-request nonce CSP and global security
headers. Upgrade with `SECURITY_CSP_MODE=auto` (or explicit `report-only`),
review/export any detected legacy footer, migrate it into safe markup,
verification records, and structured integrations, then validate DB-enabled
Turnstile, the actual signed S3 origin, inline video, and every integration in a
real browser before enabling enforce mode. Do not configure a second
proxy-wide CSP, wildcard sources, or `unsafe-inline`. Enable HSTS only after the
HTTPS topology is confirmed.

## 9. Failure and Rollback

Do not manually reverse migrations or run older application code against a newer schema.

A rollback requires:

- the exact pre-upgrade DB/config/local archive;
- previous application image/source;
- matching S3/R2 recovery point;
- matching externally managed secrets, including `SESSION_SECRET` where required.

Baseline procedure:

1. stop the failed new app;
2. restore the previous application version;
3. restore the pre-upgrade database/config/local archive;
4. restore the matching S3/R2 state;
5. verify readiness and sample data before exposure.

Current `restore.sh` keeps the normal app/dispatcher stopped while it verifies the
archive, checks schema compatibility, migrates, remediates files, neutralizes
restored tasks/provider events, and converges DB/storage state. Follow the
hardened pipeline in `backup-restore.md`.

Example baseline command:

```bash
git checkout <previous-tag-or-commit>
docker compose build app
./scripts/restore.sh /srv/backups/openlayerly/<pre-upgrade-archive>.tar.gz
```

Use `--yes` only in a reviewed recovery command.

## Operational Notes

- Store archives off-host and encrypted; they may contain member files and payment proofs.
- Monitor non-zero backup/upgrade exits and maintain adequate disk headroom for image builds and remediated objects.
- A backup that has never been restored is not a verified recovery plan.
- For v1.0 release, #88 requires current local and real/compatible S3 restore
  drills; historical baseline drills alone are insufficient.
