# Changelog

## Unreleased (v1.2 in progress)

### WP1 Email Magic Link Login

- Added fan/member Magic Link login: the login page can request a one-time
  login link, the emailed link lands on a non-consuming confirmation page, and
  only an explicit POST confirmation atomically consumes the token and creates
  the session. The email-code flow stays available as the fallback and the
  admin entry keeps email + password.
- Fixed that atomicity guarantee so token consumption, user creation/login
  metadata, and session insertion now share one PostgreSQL transaction. A
  failed session insert rolls everything back, leaving the one-time link safe
  to retry; the session cookie is still written only after commit.
- Tokens are stored only as keyed HMAC hashes in the new `magic_link_tokens`
  table (migration 0028) with a recorded key id, 15-minute TTL, single-use
  compare-and-swap consumption, and delivery through a durable
  `auth.magic_link_email` transactional task that shares the login-code
  suppression, dedupe, and rate-limit budgets.
- Added the `MAGIC_LINK_*` current+previous keyring (same semantics and Docker
  auto-provisioning as the notification unsubscribe keys). Leaving it
  unconfigured hides the login-link entry; partial configuration fails closed
  at startup.
- Token-bearing confirm pages and APIs send `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex`; confirmation
  redirects are tokenless and post-login redirects only accept allowlisted
  in-site relative paths. Request responses stay uniform to resist account
  enumeration, and magic link request/send/consume/reject security events are
  recorded with safe summaries only.

### WP3 Membership Bundle

- Added a Core-owned entitlement whitelist to membership tiers with an empty,
  non-null migration default. Tier create/update validates unknown keys
  fail-closed and records whitelisted before/after audit snapshots in the same
  transaction as the tier mutation.
- Public tier cards and the member account show localized benefit descriptions
  in Chinese, English, and Japanese. Entitlements resolve from the live current
  tier row only for active, in-window memberships.
- Content and file access continue to use tier level and `requiredTierId` through
  their shared Core membership boundary; the first entitlement bundle is
  informational and introduces no parallel grant source.
- `POST /api/admin/tiers` and `PUT /api/admin/tiers/{id}` now require a non-empty
  audit `reason` of at most 500 characters.

### WP4 G5/G7 Debt Bundle

- Upgraded GitHub Actions to their current Node 24-based supported majors and
  pinned every workflow action, including the Pages deployment, to a full
  immutable commit SHA.
- Plausible now disables its default automatic pageview capture and uses a
  nonce-authorized manual tracker for initial load and SPA history navigation.
  It emits only for the shared public route boundary, deduplicates by
  pathname plus query, and never queues private URLs.
- Existing v1.1 records that stored the former official
  `https://plausible.io/js/script.js` default are upgraded in memory to
  `script.manual.js`, so sibling integrations remain valid and the next admin
  save persists the safe manual URL. Other automatic Plausible builds remain
  rejected fail-closed.
- Added Plausible to the admin Integration status registry with Umami-equivalent
  absent, stored-disabled, stored-enabled, and invalid-stored states.

## v1.1.0 — 2026-07-17

OpenLayerlyPro v1.1.0 was released from merge commit `3a80b34`. Its acceptance
evidence (real SMTP including pacing/budget/operator recovery, deployed
dogfood, the `v1.0.0` in-place upgrade drill with mandatory file-safety
remediation, and backup/restore drills with notification keys) is recorded in
`docs/releases/v1.1.0-release-notes.md`.

### Post-v1.0.0 Hardening

These merged after the `v1.0.0` tag and ship for the first time in v1.1.0:

- Fenced provider-event dispatch end to end: claims return a discriminated claimed/already-processed/dead result, dead events dead-letter their task with an admin retry surface, all Stripe I/O moved outside the fenced business transaction, and legacy one-time paid/expired paths were unified into the same fenced pattern (PRs #135/#137).
- Fail-closed subscription event ownership: split id/ref lookups with cross-binding consistency rules, `appOwned` invoice marker propagation, and provider-clock `observedAt` fencing for pending→expired checkout transitions (PR #137).
- Hardened the AI translation endpoint URL handling (http/https only, no userinfo/fragment/query, parse-then-append call paths, `redirect: "error"`) and clarified that the monthly character limit is record-keeping only (PRs #138/#139).
- Added post-basil Stripe mock fixture variants so provider shape drift fails in CI instead of production (PR #141).
- Split the dispatcher claim query onto partial indexes and reduced stale-lease sweeps to once per tick (PR #142).
- Closed the `ensure-session-secret.mjs` TOCTOU symlink race and the FIFO-hang case with fd-based `O_NOFOLLOW|O_NONBLOCK` handling, and applied the same single-descriptor guard to the runtime `session-secret.ts` reader (PRs #143/#146).
- Bounded the admin membership history query with a default/hard-capped limit (PR #144).
- Run all three restore E2E drills in CI on every push to `main` and on demand (PR #145).
- Fixed the fan login button overflow on desktop (PR #134).

### Themes, Publishing, and Discovery

- Added the v1.1 plan, known-gaps ledger, and release-gate refresh for the "not only illustrators" direction: single-creator, self-hosted Core remains the product boundary; generic Plugin runtime, Hub, and theme marketplace are not in scope.
- Added the Blog theme and admin Appearance theme selector, then added the WordPress Classic theme with fixed presets. All landed themes share the Core view-model boundary, static theme registry, G4 zh/en/ja i18n completeness gate, and G6 Playwright visual baselines.
- Added the public Atom feed at `/feed.xml`, limited to public posts, fixed to the app default locale, capped at 100 entries, stable across cookies/headers, with strong conditional request behavior and GUIDs independent of slug changes.
- Added WP4 SEO support: sitemap index and shards, `robots.txt`, canonical/Open Graph/Twitter metadata for public content, and noindex/non-leaking metadata for login/member content.
- Added optional Umami analytics through the existing public integration/CSP revision path, with zero injection when unconfigured and deployment documentation for the supported Umami record shape.

### Admin Hardening and Editor Quality

- Completed the #147-#155 admin hardening batch: responsive shell navigation, shared admin UI primitives, payment review workflow fixes, post-editor unsaved-state protection, mobile table patterns, clearer settings source labels, keyboard/accessibility feedback, admin visual regression coverage, and safer dangerous-action dialogs.
- Closed #157 review follow-ups across admin payment APIs, editor state, dialogs, and accessibility.
- Fixed the iOS Safari Chinese IME editor freeze by stabilizing textarea height behavior and dirty-guard history/selection handling.

### Notifications and Backup Safety

- Added opt-in new-post email notifications with default-off user preferences, campaign creation on first publish/scheduled publish, recipient expansion, delivery tasks, campaign finalization, and an admin `/admin/notifications` observability page.
- Added notification queue class/priority handling so notification backlog can progress while transactional login/payment/membership/renewal email keeps reserved dispatcher capacity.
- Added notification delivery quota windows, UTC daily budget, per-minute pacing, attempt ledger, safe logging metadata, `List-Unsubscribe` / `List-Unsubscribe-Post` headers, and at-least-once product semantics. SMTP accepted means relay acceptance, not final mailbox delivery; the product wording is `不承诺不重复投递`.
- Added POST-first one-click unsubscribe tokens with dedicated current/previous unsubscribe keyring, tokenless result redirects, no-store/no-referrer/noindex token-bearing responses, and settings UI/API re-enable behavior that invalidates old tokens.
- Added notification suppression for synchronous SMTP permanent rejection from `notification.deliver` only. This is not asynchronous DSN/provider processing, and transactional email ignores the suppression list.
- Completed known-gaps G1 convergence: transactional `email` tasks now use v2 domain-reference payloads, unsafe retryable legacy rows are dead-lettered/redacted, terminal rows are redacted, and login-code tasks remain email-free.
- Upgraded backup archives to manifest v4 for notification unsubscribe/suppression key continuity, archives file-backed current/previous notification keys, validates external fingerprints before destructive restore, and neutralizes restored notification/business email tasks so unknown outcomes are not replayed.

### Supporter Wall

- Added the default-off public `/supporters` wall with explicit fan opt-in, display-name prerequisite, effective-membership eligibility derived on every request, and no email or payment-amount fallback.
- Added plain-text dedications with pending/approved/hidden moderation, one entry per user, optimistic moderation fencing, transactional audit events, and a bounded latest-200 approved-candidate public query.
- Added `/admin/supporter-wall` settings and moderation, including an optional minimum effective membership level, plus fan display-name and wall controls on the account page.
- Extended the static Theme contract with the mandatory `SupporterWall` slot across `builtin`, `blog`, and `wordpress`, with zh/en/ja coverage and desktop/mobile visual baselines.
- Added conditional `/supporters` sitemap membership and supporter-setting revalidation in the sitemap index strong ETag.

## v1.0.0 — 2026-07-06

OpenLayerlyPro v1.0.0 is released. Payment, subscription, content, file, theme, translation, S6 security response headers (#86), S7 backup/restore consistency (#87), and the post-acceptance hardening line through PR #128 are all included in the `v1.0.0` release tag.

### Final-Acceptance Hardening (after the first release-candidate report)

The 2026-06-29 release-candidate report was gathered at commit `4768aafa`; the following merged afterwards and changed runtime behavior, so #88 acceptance must be executed against the final release build:

- Resolved the initial CodeQL findings (PR #95) and pinned all third-party CI actions by commit (PR #105).
- Authenticated admin config routes before any body parsing (PR #106), then generalized this into the `check:auth-before-body` static CI gate — import-provenance and dominance analysis over every protected write handler, hardened against alias/container/wrapper bypasses (PR #125).
- Hardened restore-script child-shell argument handling (PR #107).
- Indexed cover/proof file references and bounded deletion existence checks while preserving the counted `fileInUse` contract (PRs #97/#108), then fixed file-reference integrity end to end: UUID case normalization in `lockFileReferences`, the fail-loud 0020 preflight migration with NOWAIT locking, and quarantine-race regression coverage with real backfill/pre-scan functions (PR #124).
- Verified concurrent first-time `/admin/setup` initialization is atomic (single admin, no partial init) and documented the pre-exposure operational gate (PRs #110, `docs/audit/issue-103-concurrent-setup.md`).
- Fixed subscription reconcile clock ordering: `statusEventAt` now advances through an end-of-second provider-clock observation fence with a strict-`<` live-row guard, fails closed on missing provider timestamps, and reconciled invoices use Stripe paid/created timestamps instead of local time (PRs #113, issues #102/#112; comment-precision follow-up PR #128).
- Recorded dispatcher claim-path benchmarks and classified batch-claim scalability as a non-blocking P2 follow-up (PR #111, `docs/audit/issue-101-dispatcher-design.md`).
- Added stable keyset pagination with scoped cursors to the admin payment list (PR #114).
- Retained archived-post inline images instead of deleting them with the source post (PR #118).
- Auto-generated `SESSION_SECRET` on first boot as an atomic `0600` file, stopped pinning `SESSION_SECRET_FILE` in compose so operator `.env` is honored, and hardened the restore E2E drills against host residue (PR #120).
- Provisioned `CONFIG_ENCRYPTION_KEY` atomically: single-descriptor key-file validation, chown without dereference, isolated env-mode key path, and a pre-drop archive key probe during restore (PR #126).
- Introduced archive manifest v3 with image-authoritative runtime provenance read from OCI labels/image ID (`RUNTIME_APP_VERSION`, `RUNTIME_SOURCE_COMMIT`, `RUNTIME_IMAGE_ID`, `BUILD_TIMESTAMP`), independent backup-tool provenance, and config-key fingerprint/format fields — all fail-closed on missing, duplicated, or tampered values; backup now supports paused containers, binds backup/restore to one container, and wires compose build identity (PR #127).
- Added the project website (GitHub Pages, zh/en/ja) under `website/` (PRs #116/#117).

### Payments and Memberships

- Added Stripe one-time hosted Checkout alongside the existing manual proof-review flow.
- Added full-refund and dispute reversal, charge-to-invoice resolution, reversal-first tombstones, duplicate/late event handling, and reconciliation paths.
- Added Stripe recurring subscriptions with provider-event inbox/dispatcher processing, invoice-level financial idempotency, exact Stripe billing periods, cancellation, and subscription reconciliation.
- Added manual renewal reminders for non-card deployments, with period-scoped durable tasks, user controls, stale/cancel no-op checks, and localized mail.
- Serialized all membership grants per user and deduplicated pending manual/automatic payment entry paths.

### Files, Content, and Delivery

- Added bounded request-body readers for all production Route Handlers, including exact raw Stripe webhook bytes and bounded multipart image uploads.
- Added server-authoritative image MIME detection, mandatory raster normalization, metadata stripping, frame/pixel/size limits, quarantine, attachment-only payment proofs, and the historical file-safety backfill.
- Added atomic file deletion with complete reference checks, durable object deletion, payment-proof retention/cleanup/resubmit behavior, and quota enforcement.
- Added raw-body streaming attachment uploads, local atomic `.part` writes, bounded S3 multipart uploads, streamed SHA-256, and failure compensation.
- Added inline video playback with local/S3 single-range 200/206/416 behavior, public signed playback redirects, private application proxying, and separate playback/download authorization.
- Added Markdown editing, inline images, public video embeds, scheduled publishing, categories/tags, keyset pagination, and cross-cutting authorization regression coverage.

### Authentication, Mail, and Operations

- Added S4 authentication hardening: trusted resolved/unresolved identities, high-entropy login codes, keyed email identities, persistent delivery fences, correct-code-first semantics, and source-scoped pre-comparison budgets.
- Added S5 mail reliability: failure classification, operator defer/dead behavior, stable Message-ID, delivery ledger, retry/admin visibility, and stale/cancel send guards.
- Added encrypted configuration groups and admin UI for SMTP, Turnstile, storage, upload limits, Stripe, and AI translation.
- Added archive v2 integrity, legacy schema probing, restored-task/provider-event neutralization, mandatory file-safety remediation, local/S3 convergence, and isolated recovery drills; archive manifest v3 adds image-authoritative runtime provenance, backup-tool provenance, and config-key fingerprint/format fail-closed validation.
- Added nonce-based CSP, global security response headers, dynamic Turnstile/storage/video/integration sources, revision fencing, and safe migration of legacy custom footer code.

### i18n, Translation, and Theme

- Added zh/en/ja UI, localized API errors and transactional email, and persistent user locale preferences.
- Added versioned post translations, locale fallback, manual translation management, OpenAI-compatible AI draft generation, creator-controlled review/direct-publish policy, machine-translation labeling, and stale-source detection.
- Added a Core/Theme view-model boundary, a complete built-in theme, dark mode, font variables, and server-generated color presets/custom hue.

### Release Gate

- Follow `docs/release-v1.0-checklist.md` for security, Stripe, local/S3, upgrade, backup/restore, browser, and full-CI acceptance.
- Plugin runtime, Hub, multi-instance high availability, and video transcoding/thumbnail/HLS work remain post-v1.0.

## v0.2.0 (unreleased historical candidate; superseded)

This section records the earlier candidate scope for automatic one-time payments and production-scale content delivery. It was superseded by the broader v1.0 line and is not the current release gate. The old `docs/release-v0.2-checklist.md` is retained only as a historical pointer; use `docs/release-v1.0-checklist.md` instead.

### Stripe One-Time Checkout

- Added a pluggable `PaymentProvider` abstraction with Stripe as the first hosted one-time checkout provider.
- Added encrypted Stripe configuration, admin configuration UI, integration status, and connection testing.
- Added authenticated Checkout Session creation with server-owned success/cancel URLs; OpenLayerlyPro never receives card details.
- Added raw-body Stripe webhook signature verification, provider-event idempotency, amount/currency validation, and transactional membership activation.
- Kept the existing manual screenshot payment flow available alongside automatic checkout.
- Restricted the original v0.2 candidate Checkout path to synchronous card payments; unpaid completion events did not grant membership.
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

### Historical Candidate Boundaries

At the time of this candidate, subscriptions, automatic refund/dispute handling, reconciliation, and local Range playback had not yet landed. They are now included in the v1.0 pre-release line described above. S3/R2 operators must still configure an abort-incomplete-multipart lifecycle rule as defense in depth, and process-local rate limiting remains unsuitable for multi-instance production.

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
- Uploads were read into memory before storage in that historical release; current `main` streams content attachments and buffers image purposes for validation/re-encoding.
- Process-local rate limiting is not sufficient for multi-instance production.
- Content i18n supports manual/AI drafts but AI is off by default and never visitor-triggered.

### Migrations

Existing deployments should back up the database and config encryption key before upgrading. Docker startup applies migrations before serving traffic.
