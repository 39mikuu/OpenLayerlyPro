# v1.0 Finalization Progress

Last updated: 2026-06-29 (Asia/Singapore)

## Current stage

S7 final remediation is complete on `codex/s7-backup-consistency`. Closed Draft
PR #91 is abandoned and is not a release deliverable. The final branch will be
published as a new Draft PR closing #87, pending human review and merge.

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
- Current implementation and tests at `origin/main` including merged S6

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

Human merge of the new S7 Draft PR is required before starting #88.

Operational notes:

- Docker requires `sudo -n docker` in this environment.
- Prior S6 worktree still holds port `5433`; S7 isolation uses different ports.

## Next permitted action

1. Open a new Draft PR closing #87 (do not reuse abandoned PR #91).
2. Babysit CI and address any blocking findings.
3. Wait for human merge before #88 acceptance.

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

- Human merge of the future S7 Draft PR before v1.0 acceptance may begin.
- Human authorization after review of the final release-candidate report
  before tag or GitHub Release publication.

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
