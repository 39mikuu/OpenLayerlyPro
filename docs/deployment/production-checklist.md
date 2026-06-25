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
- [ ] After S4 is implemented, auth rate-limit env bounds, login-code alphabet/length, and request-code dedupe settings have been reviewed; do not configure handoff-only variables before the implementation exists.
- [ ] After S4 is implemented, a correct login code succeeds even when wrong-attempt buckets are exhausted, and Turnstile/dedupe non-send exits do not consume the request-code send budget.
- [ ] AI translation provider is disabled unless intentionally configured.
- [ ] Custom footer code is reviewed and trusted.
- [ ] `/api/health` and `/api/ready` return 200.
- [ ] `scripts/backup.sh` runs on a schedule and copies archives off-host.
- [ ] Backups include PostgreSQL, the config encryption key, and local uploads when used.
- [ ] S3/R2 bucket versioning or provider backups are enabled when object storage is used.
- [ ] A recent archive has been restored successfully in an isolated Compose project.
- [ ] The restore drill verified `/api/ready`, sample data, uploads, and encrypted settings.

## Authentication hardening status

The current runtime still uses the pre-S4 login-code limits until the S4 implementation PR is merged. The authoritative target design is [S4 auth rate-limiting hardening](../handoff/harden-s4-auth-rate-limiting.md):

- verify throttles are wrong-attempt limiters applied only after the code is confirmed incorrect;
- correct codes bypass exhausted wrong-attempt buckets;
- request-code has no pure-email blocking 429 gate;
- email-derived limiter/dedupe identity uses normalized email plus keyed HMAC-SHA-256;
- request dedupe is non-blocking and concurrent requests create at most one code/delivery;
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