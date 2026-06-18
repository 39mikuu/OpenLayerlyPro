# Changelog

## v0.1.0-preview

Initial open-source preview release for a self-hosted single-creator membership site.

### Membership Lifecycle

- Added explicit `active`, `suspended`, and `revoked` membership states with optimistic locking.
- Added transactional grant, suspend, resume, revoke, and extend audit history.
- Disabled or hidden tiers no longer revoke access from existing paid memberships; tier availability now controls selling and display only.

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
