# Production Checklist

> This checklist describes current `main`. A production `v1.0.0` release additionally requires S7 #87 and every item in [the v1.0 acceptance checklist](../release-v1.0-checklist.md).

## Base deployment

- [ ] `APP_URL` is the public HTTPS URL.
- [ ] `SESSION_SECRET` is strong, unique, backed up separately, and not rotated unintentionally.
- [ ] The config encryption key is backed up and readable only by the deployment.
- [ ] SMTP is configured and failed/dead/deferred mail work is monitored.
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
- [ ] The task table and backups are protected as sensitive user data because durable email payloads currently store the recipient address in `payload_json.to`.

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
  public integration before enforcement.
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
- [ ] `SESSION_SECRET` is preserved separately when seamless recovery is required.
- [ ] An archive plus separately protected storage components has been restored in an isolated Compose project.
- [ ] Before v1.0 release, S7 verifies checksums, legacy schema probing, DB-aware inventory, file-safety backfill, task/payment-event neutralization and DB↔storage convergence.

## Current hardening status

S4 authentication hardening, S5 mail reliability, and S6 security response
headers are implemented. The remaining implementation blocker is S7 #87,
followed by the complete #88 acceptance gate.

## Application request-body limits

- `REQUEST_JSON_MAX_BYTES` defaults to 65,536 bytes and accepts 1,024–1,048,576.
- `STRIPE_WEBHOOK_MAX_BYTES` defaults to 262,144 bytes and accepts 1,024–1,048,576.
- `PAYMENT_PROOF_MAX_SIZE_MB` defaults to 10 MiB and accepts 1–100; multipart transport adds 256 KiB envelope allowance.
- The application measures streamed bytes when `Content-Length` is absent or inaccurate.

See [Backup and Restore](backup-restore.md) for the current baseline limitations and required isolated restore drills.
