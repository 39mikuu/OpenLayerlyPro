# AGENTS.md

Repository instructions for coding agents working on OpenLayerlyPro.

## Workspace & Git Rules

- Verify repository root, remote, current branch, HEAD, and working tree status before making changes.
- Use a dedicated branch and isolated worktree per independent issue or pull request; keep Compose project names, test databases, ports, and temporary directories isolated across concurrent worktrees.
- Never discard, reset, overwrite, or commit uncommitted work belonging to another task.
- Unless explicitly instructed by the user, do not merge PRs, mark Draft PRs ready for review, close issues, create tags/releases, force-push, rewrite shared history, delete remote branches, or touch production systems.
- Keep PRs focused on the requested scope; record unrelated defects separately instead of expanding the change.

## Architecture & Safety Boundaries

- Preserve TypeScript strictness and existing module conventions (`src/modules/*` for business logic; thin Route Handlers using bounded request-body helpers in `src/lib/request-body.ts`).
- Do not weaken validation, authorization, rate limiting, auditability, idempotency, transaction boundaries, or task fencing.
- Keep external network, SMTP, object-storage, and unrelated DB I/O outside database transactions and advisory-lock critical sections unless explicitly required by the design.
- Treat retries, duplicate delivery, stale workers, concurrent requests, partial failures, and crashes as normal execution paths.
- Never log secrets, tokens, verification codes, payment credentials, raw provider errors, or sensitive personal data.
- For shared file deletion/invalidation, check all reference paths inside the transaction and keep storage deletion retryable and idempotent.
- Before irreversible external side effects (such as sending mail), revalidate freshness and cancellation state at the last safe point.

## Database & Verification

- Use the repository scripts in `package.json` (`pnpm lint`, `pnpm format:check`, `pnpm check:request-bodies`, `pnpm check:auth-before-body`, `pnpm check:task-boundaries`, `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`, and the explicit `build:*` one-off artifacts when relevant).
- For changes depending on PostgreSQL concurrency, constraints, payments, tasks, files, or auth, run real PostgreSQL integration tests (`RUN_DB_INTEGRATION_TESTS=true pnpm test`).
- Report only checks that were actually executed, along with any skipped or unexecuted checks and remaining risks.

## Documentation & ADRs

- When behavior, env vars, scripts, or operational requirements change, update the directly affected active docs (`README.md`, `.env.example`, `docs/architecture/`, `docs/admin/`, `docs/deployment/`, `docs/development/`).
- Preserve historical ADR records under `docs/adr/`; supersede an accepted ADR with a new record rather than rewriting it in place.
