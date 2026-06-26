# Production Checklist

- [ ] `APP_URL` is the public HTTPS URL.
- [ ] `SESSION_SECRET` is strong and unique.
- [ ] SMTP is configured and tested.
- [ ] Config encryption key or key file is backed up.
- [ ] `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXY_HOPS` match the deployment edge.
- [ ] File and auth requests resolve distinct trusted client IPs in production; otherwise the operation-specific unresolved-client emergency buckets and rate-limited warnings remain active.
- [ ] Origin app port is not publicly exposed when trusting proxy headers.
- [ ] The deployment uses a single app instance unless a shared limiter has been implemented; process-local rate limits are not globally consistent across replicas.
- [ ] Application request-body limits fit expected traffic and available memory.
- [ ] Proxy request-size limits are configured only as a second layer; application byte limits remain authoritative.
- [ ] Upload limits fit available memory.
- [ ] Storage driver is selected intentionally: `local` or `s3`.
- [ ] S3/R2 credentials are stored through env or admin encrypted config.
- [ ] Reverse proxy forwards video `Range` requests and preserves `206`/`416`, `Content-Range`, and `Accept-Ranges` responses.
- [ ] Inline-video signed URL TTL, normal per-IP limits, and unresolved-client emergency limits have been reviewed for this deployment.
- [ ] Operators understand that only public S3 playback redirects; login/member S3 video remains application-proxied. See [Inline video playback](../admin/inline-video-playback.md).
- [ ] Turnstile is configured if bot protection is needed.
- [ ] Auth rate-limit env bounds, login-code alphabet/length, and request-code dedupe settings have been reviewed.
- [ ] A correct login code succeeds even when wrong/invalid-attempt buckets are exhausted; `codeIncorrect` and `codeExpired` are accounted only after core verification fails, and Turnstile/dedupe/fence non-send exits do not consume the request-code send budget.
- [ ] Login-code SMTP runs outside database transactions and per-email advisory locks; pending/processing/failed tasks suppress replacement codes, stale claims no-op, and operators accept same-code at-least-once delivery after a post-SMTP worker crash.
- [ ] Operators understand that rotating `SESSION_SECRET` makes in-flight auth login-code tasks undecryptable (`PermanentTaskError`); users request a new code within the 10-minute TTL window. Future S5 email reliability work must preserve this known behavior.
- [ ] AI translation provider is disabled unless intentionally configured.
- [ ] Custom footer code is reviewed and trusted.
- [ ] `/api/health` and `/api/ready` return 200.
- [ ] `scripts/backup.sh` runs on a schedule and copies archives off-host.
- [ ] Backups include PostgreSQL, the config encryption key, and local uploads when used.
- [ ] S3/R2 bucket versioning or provider backups are enabled when object storage is used.
- [ ] A recent archive has been restored successfully in an isolated Compose project.
- [ ] The restore drill verified `/api/ready`, sample data, uploads, and encrypted settings.

## Authentication hardening status

The current runtime implements [S4 auth rate-limiting hardening](../handoff/harden-s4-auth-rate-limiting.md):

- verify throttles account both `codeIncorrect` and `codeExpired` only after the core verification path returns failure;
- correct codes bypass exhausted wrong/invalid-attempt buckets, while the legacy `attempt_count` column is no longer read or written;
- request-code has no pure-email blocking 429 gate and returns only `{ "accepted": true }` for both normal and suppressed requests;
- email-derived limiter/dedupe identity and mail logs use purpose-separated keyed HMAC-SHA-256 rather than raw recipients;
- request dedupe plus the persistent delivery fence creates at most one active code/delivery while a task is pending, processing, or retryable failed;
- task claim and latest-active-code fences run in a short transaction, then SMTP runs after the transaction/advisory lock is released;
- a post-SMTP crash may repeat the same code at least once, and external mailbox arrival order is not guaranteed;
- process-local limits remain single-instance only.

## Application request-body limits

The application reads request bodies through byte-bounded helpers before JSON parsing, multipart parsing, Stripe signature verification, database access, storage, mail, or other business services.

- `REQUEST_JSON_MAX_BYTES` defaults to 65,536 bytes and accepts integers from 1,024 through 1,048,576.
- `STRIPE_WEBHOOK_MAX_BYTES` defaults to 262,144 bytes and accepts integers from 1,024 through 1,048,576.
- `PAYMENT_PROOF_MAX_SIZE_MB` defaults to 10 MiB and accepts integers from 1 through 100. It is the deployment hard ceiling; the admin upload setting may lower but cannot raise it. Multipart transfer buffering adds 256 KiB for boundaries, part headers, and text fields while preserving the existing per-file validation.

A reverse proxy may enforce equal or lower limits as defense in depth, but it is not a substitute for these application checks. The application also measures actual streamed bytes when `Content-Length` is absent or inaccurate.

## Backup Schedule Example

Run from the repository directory so Compose can find `.env` and `docker-compose.yml`:

```cron
15 3 * * * cd /opt/openlayerlypro && ./scripts/backup.sh /srv/backups/openlayerly >> /var/log/openlayerly-backup.log 2>&1
```

Cron only creates archives. Add a separate retention policy and off-host copy, monitor non-zero exits, and run periodic restore drills using [Backup and Restore](backup-restore.md).
