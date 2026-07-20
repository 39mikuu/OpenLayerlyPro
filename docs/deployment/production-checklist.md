# Production Checklist

> This checklist describes current `main`. `v1.0.0` is released; [the v1.0 acceptance checklist](../release-v1.0-checklist.md) passed on the exact release build and is kept as a historical record. Use this document as the operational checklist for your own deployment.

## Base deployment

- [ ] `APP_URL` is the public HTTPS URL.
- [ ] `SESSION_SECRET` resolves from the intended env/file source; all replicas share it and it is not rotated unintentionally.
- [ ] The config encryption key is backed up and readable only by the deployment.
- [ ] SMTP is configured and failed/dead/deferred mail work is monitored.
- [ ] Notification unsubscribe and suppression digest current keys are configured; previous keys are retained until token expiry or suppression rehash is complete.
- [ ] `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXY_HOPS` match the real edge topology.
- [ ] Caddy/Tunnel merged Compose config does not publish app port 3000; trusted proxy headers cannot be bypassed through a direct origin port.
- [ ] Only one app instance is running unless shared rate-limit/task coordination has been implemented.
- [ ] `/api/health` and `/api/ready` return 200.

## Request and upload limits

- [ ] Request-body, Stripe webhook, upload, and proxy limits fit expected traffic.
- [ ] Content attachment DB limits may be higher than the env fallback; proxy, disk and object-storage capacity are checked against the effective admin value.
- [ ] Payment proof/QR DB limits cannot exceed the `PAYMENT_PROOF_MAX_SIZE_MB` env ceiling.
- [ ] Memory is sized for bounded image buffers and sharp decode/re-encode work.
- [ ] S3/R2 has an abort-incomplete-multipart lifecycle rule.

## Authentication

- [ ] Turnstile uses the same effective DB/env config in the login page and request guard.
- [ ] Correct-code, wrong-attempt and source-scoped pre-comparison behavior has been tested.
- [ ] Login-code SMTP runs outside long DB transactions and stale tasks no-op.
- [ ] The effect of rotating `SESSION_SECRET` on sessions and in-flight login tasks is understood.

## Payments, subscriptions, and mail

- [ ] Manual payment and Stripe paths match the intended site configuration.
- [ ] Refund/dispute and subscription reconciliation have been exercised in Stripe Test Mode.
- [ ] Missing or broken SMTP does not silently mark business mail successful.
- [ ] Logs, admin task responses, normalized provider errors and delivery-ledger views do not expose raw recipient addresses, codes or provider secrets.
- [ ] Transactional email task payloads contain only v2 domain references; `select count(*) from tasks where kind='email' and payload_json ? 'to'` returns zero.
- [ ] Bulk notification opt-in defaults to off; archived/unpublished posts are skipped at send time.
- [ ] SMTP accepted is treated as provider relay acceptance, not final mailbox delivery, and documentation/admin language states at-least-once semantics as `不承诺不重复投递`.
- [ ] Notification suppression is limited to synchronous permanent SMTP failures from bulk notification sends; transactional email ignores the suppression list.

## Video and downloads

- [ ] Reverse proxy forwards `Range` and preserves 200/206/416 and range headers.
- [ ] Only truly public S3 video redirects; login/member/private video remains application-proxied and reauthorized.
- [ ] Private/no-store responses are not converted into public cache entries.
- [ ] Payment proofs remain attachment-only private files with strict response isolation.

## Config, integrations, and custom code

- [ ] S3/R2, SMTP, Stripe, Turnstile and Translation secrets are encrypted or protected server-side.
- [ ] AI translation is disabled unless intentionally configured; visitors cannot trigger provider calls.
- [ ] `SECURITY_CSP_MODE` is intentionally `auto`, `report-only`, or `enforce`;
  legacy footer code is migrated, explicitly disabled, or kept in the
  documented safe rollout state.
- [ ] Report-Only browser observation covers admin, public pages, login,
  DB-enabled Turnstile, the actual signed storage origin, video and every
  public integration before enforcement; Umami deployments should match
  [Umami Analytics](./umami-analytics.md).
- [ ] Production `script-src` contains neither `'unsafe-inline'` nor
  `'unsafe-eval'`; framework, theme, and integration scripts carry the response
  nonce and separate requests use separate nonces.
- [ ] `SECURITY_HSTS_ENABLED=true` only when every relevant hostname and
  subdomain is served exclusively through HTTPS.
- [ ] The proxy/CDN passes application CSP and security headers unchanged and
  does not replace the stricter file-response isolation policy.

## Backup and recovery

- [ ] Backup failures are monitored and recovery sets are copied off-host.
- [ ] Operators compare the app container's env `STORAGE_DRIVER` fallback with the effective DB-backed Storage setting; current `backup.sh` does not do this automatically.
- [ ] Every referenced local object is preserved even when the env fallback is `s3`.
- [ ] Every referenced S3/R2 object has a matching version/snapshot recovery point even when the env fallback is `local`.
- [ ] File-backed `SESSION_SECRET` is present in the checksummed archive, or the external value matches the recorded fingerprint.
- [ ] File-backed notification unsubscribe/suppression keys, including configured previous keys, are present in the v4 archive with `0600` mode, or external values match the recorded fingerprints.
- [ ] Restore drills verify notification task neutralization prevents replay of business email or bulk notification sends after restore.
- [ ] `docker compose down -v` is prohibited unless the secrets volume has a tested recovery point.
- [ ] An archive plus separately protected storage components has been restored in an isolated Compose project.
- [ ] For your deployment, verify the S7 checksums, legacy schema probing, storage inventory/convergence, file-safety backfill and task/payment-event neutralization in isolated local and S3 restore drills.

## Current hardening status

S4 authentication hardening, S5 mail reliability, S6 security response headers,
and S7 hardened recovery are implemented. The #88 real-environment acceptance
gate passed on the exact `v1.0.0` release build.

## Application request-body limits

- `REQUEST_JSON_MAX_BYTES` defaults to 65,536 bytes and accepts 1,024–1,048,576.
- `STRIPE_WEBHOOK_MAX_BYTES` defaults to 262,144 bytes and accepts 1,024–1,048,576.
- `PAYMENT_PROOF_MAX_SIZE_MB` defaults to 10 MiB and accepts 1–100; multipart transport adds 256 KiB envelope allowance.
- The application measures streamed bytes when `Content-Length` is absent or inaccurate.

## Notification runtime configuration

These values are read from runtime environment and validated by `src/lib/env.ts`:

| Variable | Default | Bounds | Operational meaning |
|---|---:|---:|---|
| `TASK_TRANSACTIONAL_RESERVED_PER_BATCH` | `8` | `0`-`20` | Slots preserved for login/payment/membership/renewal transactional work in each dispatcher batch. |
| `TASK_NOTIFICATION_MIN_PER_BATCH` | `2` | `0`-`20` | Minimum notification progress target per dispatcher batch. |
| `TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH` | `2` | `0`-`20` | Maximum stale notification leases reclaimed per dispatcher batch; due notification work remains eligible. |
| `TASK_MAINTENANCE_MAX_PER_BATCH` | `2` | `0`-`20` | Maximum maintenance tasks claimed per dispatcher batch. |
| `NOTIFICATION_EMAIL_DAILY_BUDGET` | `500` | `1`-`100000` | UTC-day SMTP-attempt budget for bulk notifications only. |
| `NOTIFICATION_EMAIL_PACING_PER_MINUTE` | `30` | `1`-`10000` | UTC-minute SMTP-attempt pacing for bulk notifications only. |
| `NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE` | `500` | `1`-`5000` | Keyset recipient expansion batch size. |
| `NOTIFICATION_DELIVERY_MAX_AGE_HOURS` | `168` | `1`-`720` | Maximum age for a notification delivery before it expires/skips. |
| `NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS` | `180` | `1`-`3650` | Maximum age for one-click unsubscribe tokens. |

Notification key material is required for production notification delivery:

- unsubscribe current key: `NOTIFICATION_UNSUBSCRIBE_KEY_ID` plus `NOTIFICATION_UNSUBSCRIBE_SECRET` or `NOTIFICATION_UNSUBSCRIBE_SECRET_FILE`;
- unsubscribe previous key, optional during rotation: `NOTIFICATION_UNSUBSCRIBE_PREVIOUS_KEY_ID` plus `NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET` or `NOTIFICATION_UNSUBSCRIBE_PREVIOUS_SECRET_FILE`;
- suppression digest current key: `NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID` plus `NOTIFICATION_SUPPRESSION_DIGEST_SECRET` or `NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE`;
- suppression digest previous key, optional during rotation: `NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_KEY_ID` plus `NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET` or `NOTIFICATION_SUPPRESSION_DIGEST_PREVIOUS_SECRET_FILE`.

Magic Link login (fan email login links) uses its own keyring with the same
current+previous semantics; leaving every `MAGIC_LINK_*` variable unset hides
the login-link entry on the login page instead of failing startup:

- magic link current key: `MAGIC_LINK_KEY_ID` plus `MAGIC_LINK_SECRET` or `MAGIC_LINK_SECRET_FILE`;
- magic link previous key, optional during rotation: `MAGIC_LINK_PREVIOUS_KEY_ID` plus `MAGIC_LINK_PREVIOUS_SECRET` or `MAGIC_LINK_PREVIOUS_SECRET_FILE`.

Direct non-empty secret env values take precedence over file paths. Docker Compose production entrypoint defaults current key file paths to `/app/secrets/notification-unsubscribe-secret`, `/app/secrets/notification-suppression-digest-secret`, and `/app/secrets/magic-link-secret`, generates missing current key files atomically with `0600` permissions, and never auto-generates previous keys.

See [Backup and Restore](backup-restore.md) for the current baseline limitations and required isolated restore drills.
