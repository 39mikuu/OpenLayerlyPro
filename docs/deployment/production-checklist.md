# Production Checklist

> This checklist describes current `main`. A production `v1.0.0` release additionally requires S6 #86, S7 #87, and every item in [the v1.0 acceptance checklist](../release-v1.0-checklist.md).

## Base deployment

- [ ] `APP_URL` is the public HTTPS URL.
- [ ] `SESSION_SECRET` is strong, unique, backed up separately, and not rotated unintentionally.
- [ ] Config encryption key or key file is backed up and readable only by the deployment.
- [ ] SMTP is configured and tested; failed/dead/deferred mail tasks and the delivery ledger are monitored.
- [ ] `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXY_HOPS` match the real edge topology.
- [ ] File and auth requests resolve distinct trusted client IPs; operation-specific unresolved emergency buckets are not treated as a normal production identity source.
- [ ] Origin app port is not publicly exposed when trusting proxy-provided single-value IP headers.
- [ ] Only one app instance is running unless shared rate-limit/task coordination has been implemented.
- [ ] `/api/health` and `/api/ready` return 200; optional integration summary is inspected without making it a Core readiness gate.

## Request and upload limits

- [ ] Request-body, Stripe webhook, upload, and proxy limits fit expected traffic.
- [ ] Proxy request-size limits are defense in depth; application actual-byte limits remain authoritative.
- [ ] Content attachments stream to storage; memory is sized for bounded image buffers and sharp decode/re-encode work.
- [ ] S3/R2 bucket has abort-incomplete-multipart lifecycle rules.
- [ ] Storage driver is intentional; switching active driver does not migrate historical files.

## Authentication

- [ ] Turnstile is intentionally configured and uses the same effective DB/env config as the login page and request guard.
- [ ] Auth bounds, login-code alphabet/length, keyed email identity, request dedupe, and delivery-fence settings have been reviewed.
- [ ] A correct code succeeds even when wrong/invalid-attempt buckets are exhausted.
- [ ] Wrong/expired results are accounted only after core verification fails.
- [ ] Source-scoped pre-comparison budgets throttle expensive comparisons without blocking another trusted IP.
- [ ] Login-code SMTP runs outside DB transactions/advisory locks; stale claims no-op and a post-SMTP crash may repeat the same code.
- [ ] Rotating `SESSION_SECRET` invalidates sessions and makes old encrypted login-code tasks undecryptable.

## Payments, subscriptions, and mail

- [ ] Manual payment proof review and Stripe paths match the site's intended configuration.
- [ ] Stripe webhook endpoint uses HTTPS and subscribes to events required by one-time payments and subscriptions.
- [ ] Browser redirects never grant membership without a valid persisted provider event.
- [ ] Refund/dispute and subscription reconciliation have been exercised in Stripe Test Mode.
- [ ] SMTP operator-defer and max-age settings are reviewed; unconfigured/auth-failed business mail does not silently succeed.
- [ ] Stable Message-ID and delivery ledger/admin retry views are usable without exposing provider secrets or raw recipient data.

## Video and downloads

- [ ] Reverse proxy forwards `Range` and preserves 200/206/416, `Content-Range`, `Content-Length`, and `Accept-Ranges`.
- [ ] Inline-video signed URL TTL and rate limits have been reviewed.
- [ ] Only truly public S3 video redirects; login/member/private video remains application-proxied and reauthorized per request.
- [ ] Private/no-store responses are not rewritten into public CDN cache entries.
- [ ] Payment proofs remain attachment-only private files with strict response isolation.

## Config, integrations, and custom code

- [ ] S3/R2, SMTP, Stripe, Turnstile and Translation secrets are stored in encrypted admin config or protected server-side env.
- [ ] AI translation is disabled unless intentionally configured; visitors cannot trigger provider calls.
- [ ] Custom footer code is reviewed and trusted in the current runtime.
- [ ] Before enforcing S6 CSP, legacy footer code is migrated, explicitly disabled, or kept in the documented safe rollout state.
- [ ] S6 browser verification covers DB-enabled Turnstile, actual signed storage origin, video and public integrations.

## Backup and recovery

- [ ] `scripts/backup.sh` runs on a schedule, failures are monitored, and archives are copied off-host.
- [ ] Backups include PostgreSQL, config encryption key, and local uploads when used.
- [ ] `SESSION_SECRET` is preserved separately when seamless recovery is required.
- [ ] S3/R2 versioning, snapshot, or provider backup is enabled and tested.
- [ ] A recent archive has been restored in an isolated Compose project.
- [ ] Current baseline restore verified `/api/ready`, sample data, uploads and encrypted settings.
- [ ] Before v1.0 release, S7 #87 additionally verifies checksums, legacy schema probing, file-safety backfill, task/payment-event neutralization and DB↔storage convergence.

## Current hardening status

The runtime implements S4 authentication hardening and S5 mail reliability. The remaining release blockers are S6 #86 and S7 #87; neither is complete merely because its handoff document exists.

## Application request-body limits

- `REQUEST_JSON_MAX_BYTES` defaults to 65,536 bytes and accepts 1,024–1,048,576.
- `STRIPE_WEBHOOK_MAX_BYTES` defaults to 262,144 bytes and accepts 1,024–1,048,576.
- `PAYMENT_PROOF_MAX_SIZE_MB` defaults to 10 MiB and accepts 1–100; multipart transport adds 256 KiB envelope allowance.
- The application measures streamed bytes when `Content-Length` is absent or inaccurate.

## Backup schedule example

Run from the repository directory:

```cron
15 3 * * * cd /opt/openlayerlypro && ./scripts/backup.sh /srv/backups/openlayerly >> /var/log/openlayerly-backup.log 2>&1
```

Cron only creates archives. Add retention, off-host copy, non-zero-exit monitoring and periodic isolated restore drills using [Backup and Restore](backup-restore.md).
