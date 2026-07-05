# v1.0 Finalization Progress

Last updated: 2026-07-05 (Asia/Singapore)

## Current stage

The release PR (`chore/release-v1.0.0`) freezes documentation and the 1.0.0
package version. After the first release-candidate report was gathered at
`4768aafa` (2026-06-29), a post-acceptance hardening line merged through PR
#128 — including runtime changes (auth-before-body static gate #125,
file-reference integrity #124, atomic `CONFIG_ENCRYPTION_KEY` provisioning
#126, image-authoritative archive manifest v3 #127, reconcile provider-clock
fence #113, auto `SESSION_SECRET` #120) — so the #88 real-environment
acceptance matrix must be re-executed against the exact release build after
this PR merges. No tag, release, issue closure, production mutation, or
autonomous publication is allowed until #88 passes.

### 2026-07-05 update

- Hardening PRs merged since the RC report: #95, #105, #106, #107, #108, #110,
  #111, #113, #114, #116, #117, #118, #120, #124, #125, #126, #127, #128
  (final merge commit `c846e2a`).
- Release PR prepared from baseline `c846e2a`: CHANGELOG hardening section,
  README/roadmap/SECURITY status sync, draft release notes
  (`docs/releases/v1.0.0-release-notes.md`), and the 1.0.0 version bump as the
  final commit.
- The 2026-06-29 release-candidate report remains a point-in-time evidence
  record for `4768aafa`; its unexecuted-blockers list (Stripe/SMTP/CSP
  observation/AI provider/secret custody/security-alert review) still stands
  and now must be evidenced on the release build.

## Authoritative inputs read

- Goal objective: user-provided v1.0 finalization plan (2026-06-27)
- Repository-root `AGENTS.md` at `origin/main`
- GitHub issue #86 (closed by merged PR #90)
- `docs/handoff/harden-s6-security-response-headers.md`
- GitHub issue #87
- `docs/handoff/harden-s7-backup-consistency.md`
- GitHub issue #88
- `docs/release-v1.0-checklist.md`
- Accepted ADR 0007, `docs/adr/0007-inline-video-playback.md`
- Accepted ADR 0008, `docs/adr/0008-public-video-embeds.md`
- Accepted ADR 0011, `docs/adr/0011-upload-file-safety.md`
- Accepted ADRs 0001–0011
- Current implementation and tests at `origin/main` including merged S6 and S7

## Base, branch, and worktree

- Repository: `/home/miku/OpenLayerlyPro`
- Canonical remote: `origin = https://github.com/39mikuu/OpenLayerlyPro.git`
- Preserved fork remote:
  `fork = https://github.com/3140702049/OpenLayerlyPro.git`
- S7 base commit: `2cd51b76` (`Merge pull request #90 from
  39mikuu/codex/s6-security-response-headers`)
- PR #89 merge commit present in base:
  `bb5d6e4f` (`Merge pull request #89 from
  39mikuu/docs/refresh-roadmap-v1-status`)
- S7 branch: `codex/s7-backup-consistency`
- S7 worktree: `/home/miku/OpenLayerlyPro-s7`
- S7 HEAD at preflight: `2cd51b76`
- Acceptance base/HEAD at preflight: `4768aafa`
- Acceptance branch: `codex/v1-acceptance`
- Acceptance worktree: `/home/miku/OpenLayerlyPro-v1-acceptance`
- Acceptance isolation:
  - Docker Compose project prefix: `openlayerlypro_v1_acceptance_88`
  - PostgreSQL test database: `openlayerlypro_v1_acceptance_88_test`
  - PostgreSQL port: `5435`
  - app/browser port: `3009`
- Planned S7 isolation:
  - Docker Compose project: `openlayerlypro_s7_87`
  - PostgreSQL test database: `openlayerlypro_s7_87_test`
  - App port: `3003`
  - PostgreSQL port: `5434`
- Unrelated worktrees (do not modify):
  - `/home/miku/OpenLayerlyPro` (stale local `main` at `896ff137`)
  - `/home/miku/OpenLayerlyPro-s6` (merged S6 branch; port `5433` still listening)
  - `/tmp/OpenLayerlyPro-pr16` (prunable)

## Completed work

### Preflight (post-S6 merge)

- Fetched canonical `origin/main`; confirmed PR #89 and merged PR #90 are present.
- Recorded S7 base SHA `2cd51b76`.
- Confirmed unrelated worktrees and that primary checkout is clean.
- Confirmed 27 GiB free disk, ~1.8 GiB available memory.
- Confirmed Node `v22.22.3` and pnpm `10.33.0`.
- Confirmed Docker client present; daemon requires `sudo -n docker` (socket
  permission denied for unprivileged user).
- Confirmed port `5433` is occupied by prior S6 work; S7 will use `5434`/`3003`.
- Created isolated S7 worktree and branch from `origin/main`.
- Read `docs/handoff/harden-s7-backup-consistency.md` and inspected baseline
  `scripts/backup.sh` / `scripts/restore.sh` (currently `FORMAT_VERSION=1`,
  no checksums, no task neutralization, no pre-start convergence).

### S6 (complete — merged)

- PR #90 merged at `2026-06-27T13:31:28Z`.
- Merge commit: `2cd51b76`.
- Implementation commits: `e17e623b`, `8d78e15a`.
- GitHub CI on implementation commit passed (run `28289793610`).
- Independent review verdict: APPROVE; no blocking findings at merge time.

## Commands actually executed (S7 preflight)

```text
git fetch origin
git log --oneline -1 origin/main
git merge-base --is-ancestor bb5d6e4f origin/main
gh pr view 90 --json state,mergedAt,mergeCommit
gh pr view 89 --json state,mergedAt,mergeCommit
git worktree list
git status --porcelain
node -v
pnpm -v
df -h /home/miku /tmp
free -h
docker info
  exit non-zero: permission denied on /var/run/docker.sock
ss -tlnp | grep -E ':(3000|3001|5432|5433)'
git worktree add /home/miku/OpenLayerlyPro-s7 \
  -b codex/s7-backup-consistency origin/main
  HEAD 2cd51b76
```

## Open reviewer findings

None known. Final local validation is green; the new S7 Draft PR still requires
human review and merge.

## Blockers

No implementation blocker. Real external Stripe, SMTP, R2/Tunnel, and production
CSP observation requirements may remain unexecuted if credentials/infrastructure
are unavailable; they must be reported as blocked rather than replaced by mocks.

Operational notes:

- Docker requires `sudo -n docker` in this environment.
- Prior S6 worktree still holds port `5433`; S7 isolation uses different ports.

## Next permitted action

1. Execute the complete #88 acceptance matrix from immutable commit `4768aafa`.
2. If a concrete release blocker is found, create a focused defect branch/PR and
   stop for human merge before rerunning the affected section.
3. Otherwise prepare the fully evidenced release-candidate report and stop at the
   human publication gate.

## S7 work completed so far

- `src/modules/restore/*` core modules: schema compatibility, pre-scan, neutralize,
  converge, schema check.
- One-off artifacts: `dist/restore-pre-scan.mjs`, `dist/restore-neutralize.mjs`,
  `dist/restore-converge.mjs`, `dist/restore-schema-check.mjs`.
- `scripts/backup.sh` upgraded to `FORMAT_VERSION=2` with checksums and migration
  identity.
- `scripts/restore.sh` hardened with full pre-start pipeline and v1 temp-DB probe.
- Dockerfile copies restore artifacts; CI builds/verifies all one-off artifacts and
  runs shellcheck on backup scripts.
- Docs: `docs/deployment/backup-restore.md` updated for S7 behavior.
- Tests: 1086 passing across 140 files (`RUN_DB_INTEGRATION_TESTS=true` on isolated DB
  `openlayerlypro_s7_87_test`), including restore integration tests.
- E2E drill (2026-06-28, round-2): `./scripts/test-restore-e2e.sh` **passed** @
  `21f0b43e`. Archive:
  `/tmp/openlayerlypro-s7-e2e-backups/openlayerly-backup-20260627-192950.tar.gz`.
  encryptionKey ready ok, quarantine=1, delete tasks=0.
- Checksum gate drill: `./scripts/test-restore-checksum-gate.sh` rejects tampered
  payload (`sha256sum -c`) and undeclared extra files (bijection mismatch).
- Bundle fix: esbuild one-offs use `createRequire` banner; `sharp` external;
  slim imports (`storageResolve`, `storage/runtime`, `tasks/enqueue`) avoid
  bundling Next.js into restore tools.

## Final worktree validation (2026-06-29)

All restore drills were re-run against the final worktree. Each drill tears down its isolated Compose projects
(`down -v`) and removes its generated `.env`/override/temp files on exit.

- Local E2E — `./scripts/test-restore-e2e.sh` → **passed**.
  Valid `renewal_reminder` payload settles as a no-op `succeeded`;
  `subscription.reconcile` runs and defers (pending, `run_after` in the future);
  provider event reaches `processed` with its dispatch task `succeeded`;
  quarantine 410, intact download 200, nested `UPLOAD_DIR=/app/uploads/e2e-nested`.
- MinIO/S3 E2E — `./scripts/test-restore-s3-e2e.sh` → **passed**.
  ListObjectsV2 pagination forced (`--page-size=2` over 6 `content/` objects);
  both seeded and injected orphans confirmed deleted from MinIO with their
  `storage.delete_object` tasks `succeeded`; out-of-prefix sentinel left untouched;
  truncated convergence and denied `ListObjectsV2` with allowed `GetObject` both
  fail closed (app never starts).
- Legacy v1 path — `./scripts/test-restore-v1-e2e.sh` → **passed**.
  Custom URL-reserved PostgreSQL credentials (`s7_v1_user` / `p@ss:w0rd/v1#x`) drive
  the isolated schema probe through `restore.sh`; compatible archive restores to
  ready; unknown-schema archive fails closed without `--allow-legacy-v1-unknown-schema`
  and is overridden with it; the probe database is cleaned up on success, on failure,
  and after SIGTERM (signal-path cleanup observed).
- Checksum gate — `./scripts/test-restore-checksum-gate.sh <v2-archive>` → **passed**.
  Rejects tampered payload (`sha256sum -c`), undeclared extra files (bijection
  mismatch), counts nested `checksums.sha256` names, and invokes the production
  validator to reject symlink and FIFO payloads.
- Full test suite — `pnpm test` with DB integration enabled → **140 files /
  1086 tests passed**.
- Static/build gates — lint, Prettier check, bounded request-body check,
  TypeScript, ShellCheck, restore artifact builds, Next.js production build, and
  default production Docker image contract → **passed**.
- Default Docker image contains all required restore artifacts, contains no E2E
  mutation tools, and has no `/app/.e2e-tools` marker.
- Cleanup verification found no remaining drill containers; only the intentional
  isolated test PostgreSQL container `openlayerlypro_s7_87-postgres` remained.

Schema-compatibility variants (compatible / newer / diverged / unknown / override)
remain covered by `schemaCompatibility.test.ts` and `schemaCheck.integration.test.ts`;
the v1 drill above exercises the same gate end-to-end through the shell path.

## Human gates still required

- Human/operator execution of the external acceptance blockers listed below.
- Human authorization after review of a fully passing final release-candidate
  report before tag or GitHub Release publication.

## Final acceptance evidence (2026-06-29)

- Base/tested main commit: `4768aafa523924dc9b3b25815a5467df45ca6fb4`.
- Frozen install, lint, formatting, bounded-body check, TypeScript, 140 test
  files / 1086 tests, all one-off builds, production build and ShellCheck passed.
- Real Chromium S6 browser E2E passed.
- Fresh isolated Compose install, `/admin/setup`, health and readiness passed.
- Caddy/Tunnel merged configs publish no app host port.
- Local, MinIO/S3, legacy-v1 and checksum/contract recovery drills passed.
- `v0.1.0` → current migration/backfill/startup/admin/config upgrade drill passed.
- Production image digest and one-off artifact hashes are recorded in
  `docs/releases/v1.0.0-release-candidate-report.md`.
- Exact-main GitHub CI run `28351135351` passed.
- Acceptance-report GitHub CI run `28352507902` passed on commit
  `a61b6633382de479297e5ba3bde1fb61687e65bc`.

### Unexecuted blockers

- No Stripe Test Mode credentials, SMTP server, operator R2/S3/Tunnel topology,
  or OpenAI-compatible provider credentials were available.
- Actual CSP report-only observation against the operator's external origins and
  integrations was therefore not executable.
- Dependabot, Code Scanning/CodeQL and Secret Scanning REST endpoints returned
  404 to the current token; alert status is unproven.
- Operator custody of off-host external secrets and provider recovery points
  cannot be established from this isolated environment.

The release decision is **HOLD**. No tag, Release, issue closure or production
mutation is permitted while these blockers remain.

## PR #92 review remediation (Review 4588088584)

- Storage payload shape and v2 manifest semantics are now validated before
  confirmation, service stop, compatibility probing, or any official DB/key
  replacement. Missing, dual, and manifest-mismatched forms fail closed.
- The app stop failure is no longer ignored; an existing app container must stop
  successfully and Compose must report no running app container before restore
  continues.
- Local backup rejects symlinks and special files in the live upload tree, reuses
  the production payload validator on the assembled workspace, and atomically
  publishes the final archive only after all validation/checksum/tar steps pass.
- Local E2E sentinel cases prove malformed storage contracts leave the official
  database and config key unchanged. Backup-side symlink/FIFO cases prove no final
  archive is published.
- Final remediation drills: checksum/contract gate, local E2E, MinIO/S3 E2E, and
  v1 compatibility E2E all passed.
