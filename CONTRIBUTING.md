# Contributing

Thanks for helping improve OpenLayerlyPro.

## Local Development

```bash
pnpm install
docker run -d --name ams-postgres \
  -e POSTGRES_DB=artist_member \
  -e POSTGRES_USER=artist \
  -e POSTGRES_PASSWORD=artist_password \
  -p 5432:5432 postgres:16
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Development mode can log email login codes when SMTP is not configured. Production must use real SMTP.

## Validation

Run the same baseline checks as CI before opening a PR:

```bash
pnpm lint
pnpm format:check
pnpm check:request-bodies
pnpm exec tsc --noEmit
pnpm test
pnpm build:migrator
pnpm build
```

Security/payment/file/task changes that depend on PostgreSQL behavior must also run the real database suite:

```bash
RUN_DB_INTEGRATION_TESTS=true pnpm test
```

Migration changes must include generation/drift review and an isolated upgrade test where relevant:

```bash
pnpm exec drizzle-kit generate
pnpm db:migrate
pnpm build:migrator
```

Shell/deployment changes must pass shellcheck and a clean Compose or isolated recovery drill appropriate to their scope. Browser-facing CSP/Range/authorization changes require a real browser or equivalent E2E check; unit tests alone are insufficient.

## Pull Request Rules

- Use small PRs with a clear scope.
- State whether the PR changes schema/migrations, auth/session/security, payments/subscriptions, durable tasks/mail, file upload/download/storage, AI translation, theme/plugin boundaries, deployment, backup/restore, or public behavior.
- Keep Route Handlers thin. Use bounded request-body helpers and put business logic in `src/modules/*`.
- Add or update tests for every affected security, permission, payment, task, file, translation, config, or recovery invariant.
- Update `.env.example`, README, active architecture/admin/deployment docs, and release guidance when behavior changes.
- Preserve historical ADR meaning; supersede an accepted ADR with a new record rather than silently rewriting the decision.
- Do not add dependencies unless the PR explains why they are necessary and reviews supply-chain impact.
- Keep security-sensitive PRs Draft until their authoritative real-PostgreSQL/browser/restore checks are complete.

## Sensitive Areas

Changes in these areas need explicit invariants and failure-path tests:

- auth/session/login-code/Turnstile and trusted-client identity;
- payment creation, Stripe webhook inbox/dispatcher, subscriptions, refunds/disputes and membership grants;
- durable tasks, claim/lease/fencing and email delivery;
- file upload normalization, authorization, Range, references, deletion and storage drivers;
- config encryption, secrets and public integration rendering;
- custom footer migration and Content Security Policy;
- AI translation cost triggers, provider calls, review and publication;
- backup/restore, upgrade remediation and DB↔storage convergence;
- Plugin/Theme boundaries.

## Database Migrations

Schema changes require a migration under `src/db/migrations/`. Production startup runs the bundled forward migrator before the app; failed migrations stop startup.

Do not edit released migration semantics in place. Remediation needed before a new constraint must be explicit, report-first, fail-safe, auditable, idempotent where possible, and documented in the upgrade path.

Downgrade migrations are not supported. Rollback after a forward migration requires the previous application version plus a matching pre-upgrade DB/storage/secret recovery point.
