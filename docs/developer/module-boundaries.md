# Module Boundaries

## Core Modules

- `auth`: admin login, fan login codes, sessions
- `membership`: tiers and grants
- `payment`: payment methods, requests, review state
- `content`: posts, visibility, localization
- `file`: upload metadata, validation, delete reference checks
- `download`: authorization, signed URLs, logs
- `storage`: local and S3/R2 drivers
- `site`: public/admin site settings
- `config`: encrypted integration and system config
- `theme`: public rendering contracts
- `i18n`: locale resolution and dictionaries
- `translation`: provider adapter, drafts, review workflow

## Boundaries

- Admin APIs must call `requireAdmin`.
- User-owned APIs must call `requireUser`.
- Storage drivers should not decide business permissions.
- Theme components receive view models and must not perform admin-only business logic.
- AI translation must remain admin-triggered and disabled by default.
