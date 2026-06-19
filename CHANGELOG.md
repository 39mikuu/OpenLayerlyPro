# Changelog

## v0.2.0

Release candidate for automatic one-time payments and production-scale content delivery. The release remains pending final external smoke tests listed in `docs/release-v0.2-checklist.md`.

### Stripe One-Time Checkout

- Added a pluggable `PaymentProvider` abstraction with Stripe as the first hosted one-time checkout provider.
- Added encrypted Stripe configuration, admin configuration UI, integration status, and connection testing.
- Added authenticated Checkout Session creation with server-owned success/cancel URLs; OpenLayerlyPro never receives card details.
- Added raw-body Stripe webhook signature verification, provider-event idempotency, amount/currency validation, and transactional membership activation.
- Kept the existing manual screenshot payment flow available alongside automatic checkout.
- Restricted v0.2 Checkout to synchronous card payments; unpaid completion events do not grant membership.
- Added signed `checkout.session.expired` handling for stale `pending_payment` requests.
- Added stable `checkout:<requestId>` Stripe idempotency keys so network retries cannot create duplicate sessions.
- Added a two-minute PostgreSQL-time lease for temporary `creating:*` claims, with advisory-lock recovery and fencing so crashed or delayed processes cannot overwrite a newer checkout.

### List Pagination

- Added keyset pagination for published post lists ordered by `published_at DESC, id DESC`.
- Limited the home page to the latest posts instead of loading the full catalog.
- Preserved category, tag, visibility, and locale behavior across paginated requests.
- Preserved PostgreSQL microsecond precision in opaque cursors.
- Added semantic timestamp validation so malformed or impossible cursor dates safely fall back to the first page instead of reaching PostgreSQL casts.

### Streamed Attachments and Video

- Added a dedicated raw-body streaming endpoint for `content_attachment` uploads while preserving buffered Sharp validation for images and payment proofs.
- Added streamed byte counting and SHA-256 calculation with an authoritative server-side size limit.
- Added `mp4`, `webm`, `mov`, and `m4v` attachment support with canonical MIME types.
- Added local same-directory `.part` writes, atomic rename, catchable-failure cleanup, and stale-part cleanup.
- Added bounded S3/R2 multipart uploads using 8 MiB parts, queue size 2, and incomplete-part abort behavior.
- Added cleanup compensation for aborts, oversize uploads, empty bodies, storage failures, and database insert failures.

### Upgrade and Compatibility

- Existing manual payments, image uploads, payment-proof uploads, authorization, and historical local/S3 file access remain supported.
- Existing deployments must back up PostgreSQL, local uploads, and the configuration encryption key before upgrading.
- Docker startup continues to apply database migrations before serving traffic.
- Final release acceptance is documented in `docs/release-v0.2-checklist.md`.

### Known Limitations

- Refund, chargeback, and automatic payment reconciliation workflows are not included in v0.2.0.
- Automatic renewals and subscriptions are not included.
- Local downloads do not yet implement HTTP Range/206 seeking; authenticated video upload and download are supported, while inline seeking/player polish remains B2.
- S3/R2 operators should configure an abort-incomplete-multipart lifecycle rule as crash-recovery defense in depth.
- Process-local rate limiting is still not sufficient for multi-instance production.

## v0.1.0

Initial open-source preview/alpha release for a self-hosted single-creator membership site. This release completes the v1 Core readiness hardening: all state changes are transactional and auditable, with regression-test coverage.

### Membership Lifecycle

- Added explicit `active`, `suspended`, and `revoked` membership states with optimistic locking (`version`).
- Added transactional grant, suspend, resume, revoke, and extend with audit history; invalid transitions and stale writes are rejected deterministically.
- Disabled or hidden tiers no longer revoke access from existing paid memberships; tier availability now controls selling and display only.
- Added admin lifecycle controls (state + audit timeline, confirm + reason) and removed the legacy unaudited membership write/delete routes.

### Payments, Audit & Reliable Delivery

- Added a shared `audit_events` table and in-transaction `recordAudit`, with `correlation_id` / `causation_id` causal linkage; sensitive snapshots use field whitelists (no secrets).
- Payment approve / reject / resubmit / cancel now write durable audit events in the same transaction; approval records the exact granted membership.
- Added payment reversal: reverses an approved payment and revokes the linked membership atomically; legacy approvals without a grant link are rejected rather than silently skipped.
- Added a durable, single-instance task outbox (database-backed, lease + claim fencing, bounded retries, admin retry view). Activation and rejection emails are now enqueued in-transaction instead of best-effort inline sends.

### Content Publishing & Organization

- Added scheduled publishing via `posts.scheduled_at` + `schedule_token` (no new post status), with token fencing so superseded/cancelled schedules cannot publish; early-firing tasks defer without consuming retry budget.
- Decoupled translation staleness from row updates via `content_updated_at`.
- Added tags and categories (separate tables + join tables), admin management, post association, public display, and `?category=` / `?tag=` filtering. Taxonomy is organizational only and does not affect access control.

### Admin Account, Sessions & Recovery

- Added admin email/password maintenance with current-password re-authentication; password changes revoke other sessions while preserving the current one.
- Added active-session visibility and revocation (single / others) and an admin account-action audit timeline.
- Added a non-interactive `scripts/admin-reset.mjs` recovery command for lockout, which also revokes all sessions for the recovered account.

### Operations & Hardening

- Added `scripts/backup.sh` / `scripts/restore.sh` covering the database, local uploads, and the config encryption key in a single archive, with a verified clean-environment restore drill, S3/R2 handling, and backup-based upgrade rollback.
- Added a PostgreSQL-backed cross-cutting regression suite for download/file authorization (purpose × role × post status × visibility × membership state), audit causality, idempotent delivery, stale/duplicate handling, and end-to-end rollback.
- Bumped `nodemailer` to `^9.0.1` (the v9 remote-content TLS change does not affect SMTP-only email sending).

### MVP

- Site initialization and admin setup.
- Admin dashboard for site settings, tiers, posts, files, payment methods, payment reviews, users, integrations, and translation review.
- Fan email-code login with Turnstile support.
- Manual screenshot payment flow: choose tier, pay externally, upload proof, admin review, membership activation.
- Public/login/member post visibility.
- Permission-checked downloads and download logs.
- Local storage and S3/R2-compatible object storage.

### Security and Operations

- HMAC-hashed session tokens.
- Production `SESSION_SECRET` enforcement.
- One-time email login codes with attempt limits.
- Trusted proxy IP parsing for rate limiting and audit metadata.
- Process-local rate-limit cleanup and bucket cap.
- Config encryption root key generation and persistence for Docker deployments.
- Health and readiness endpoints.
- Private vulnerability reporting guidance.

### Theme

- Creator-support default public theme.
- Homepage, posts, post detail, tiers, checkout, login, account, orders, and mobile navigation polish.
- Custom site logo/icon and favicon fallback.
- Admin-managed custom footer HTML for trusted self-hosting snippets.

### i18n and Translation

- UI i18n for `zh`, `en`, and `ja`.
- Localized API errors and transactional emails.
- User locale persistence.
- Content translation data model.
- Manual translation management and AI-assisted draft generation.
- Translation provider config with OpenAI-compatible chat completions.
- Review workflow and machine-translation label policy.

### Repository and License

- Public repository moved to `39mikuu/OpenLayerlyPro`.
- Project licensed under `AGPL-3.0-only`.
- Added README, security policy, contribution guide, release audit, release checklist, and GitHub templates.

### Known Limitations

- v0.1 does not include automatic payment providers or webhooks.
- v0.1 does not include comments, likes, follows, favorites, or discovery feeds.
- v0.1 is intended for one creator per deployment.
- Uploads are read into memory before storage; tune upload limits for small servers.
- Process-local rate limiting is not sufficient for multi-instance production.
- Content i18n supports manual/AI drafts but AI is off by default and never visitor-triggered.

### Migrations

Existing deployments should back up the database and config encryption key before upgrading. Docker startup applies migrations before serving traffic.
