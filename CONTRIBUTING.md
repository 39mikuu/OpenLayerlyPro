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

Run these before opening a PR:

```bash
pnpm test
pnpm lint
pnpm format:check
pnpm exec tsc --noEmit
pnpm build
```

When migrations change, also run the project migration flow:

```bash
pnpm db:migrate
pnpm build:migrator
```

## Pull Request Rules

- Use small PRs with a clear scope.
- State whether the PR changes schema, migrations, auth/session/security, payments, file upload/download, AI translation, plugin/theme boundaries, or public behavior.
- Keep route handlers thin. Put business logic in `src/modules/*`.
- Add or update tests for security, permission, payment, file, translation, or config behavior.
- Update `.env.example`, README, and docs when env or deployment behavior changes.
- Do not add dependencies unless the PR explains why they are necessary.

## Sensitive Areas

Changes in these areas need extra explanation and tests:

- auth/session/login-code flow
- payment request creation and review
- file upload/download and storage drivers
- config encryption and secrets handling
- custom footer code rendering
- AI translation cost triggers and provider calls
- plugin/theme boundaries

## Database Migrations

Schema changes must include a migration file under `src/db/migrations/`. Production Docker startup runs the bundled migrator before starting the app; failed migrations stop the container.

Do not change existing migration semantics after release unless the PR explicitly documents why it is safe.
