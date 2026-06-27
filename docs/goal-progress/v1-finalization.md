# v1.0 Finalization Progress

Last updated: 2026-06-27 (Asia/Singapore)

## Current stage

S6 implementation, complete local verification, final independent review, and
Draft PR publication are complete. PR #90 remains Draft and its implementation
commit passed GitHub CI. The current stage is the human S6 merge gate; S7 must
not begin before that merge.

## Authoritative inputs read

- Goal objective:
  `/home/miku/.codex/attachments/9fe53ef4-f803-41f8-8b35-bd1fbb687cca/goal-objective.md`
- Repository-root `AGENTS.md` at `origin/main`
- GitHub issue #86
- `docs/handoff/harden-s6-security-response-headers.md`
- GitHub issue #87
- `docs/handoff/harden-s7-backup-consistency.md`
- GitHub issue #88
- `docs/release-v1.0-checklist.md`
- Accepted ADR 0007, `docs/adr/0007-inline-video-playback.md`
- Accepted ADR 0008, `docs/adr/0008-public-video-embeds.md`
- Accepted ADR 0011, `docs/adr/0011-upload-file-safety.md`
- Current implementation and tests at `origin/main`

## Base, branch, and worktree

- Repository: `/home/miku/OpenLayerlyPro`
- Canonical remote: `origin = https://github.com/39mikuu/OpenLayerlyPro.git`
- Preserved fork remote:
  `fork = https://github.com/3140702049/OpenLayerlyPro.git`
- Base commit: `8d85e81b08d257f6382bfabe0c78351741e28b56`
- PR #89 merge commit present in base:
  `bb5d6e4f` (`Merge pull request #89 from
  39mikuu/docs/refresh-roadmap-v1-status`)
- Branch: `codex/s6-security-response-headers`
- Worktree: `/home/miku/OpenLayerlyPro-s6`
- Reviewed implementation commit:
  `e17e623b97dfca82043c88372c956b1811d9bef5`
- Draft PR: `https://github.com/39mikuu/OpenLayerlyPro/pull/90`
- Docker Compose project: `openlayerlypro_s6_86`
- PostgreSQL test database: `openlayerlypro_s6_86_test`
- Isolated app/PostgreSQL ports: `3001`, `5433`; standalone image smoke:
  `3002`

## Completed work

- Verified repository path, remotes, branch, HEAD, status, and active
  worktrees.
- Identified a stale fork configured as `origin`; preserved it as `fork` and
  made the authoritative repository the `origin` remote.
- Fetched canonical `origin/main`.
- Confirmed PR #89 is present in canonical `origin/main`.
- Recorded the exact base commit.
- Confirmed the primary checkout and new S6 worktree were clean before
  changes.
- Identified the unrelated prunable worktree
  `/tmp/OpenLayerlyPro-pr16`; it will not be modified.
- Confirmed 33 GiB free disk and 2.3 GiB available memory.
- Confirmed Node `v22.22.3` and pnpm `10.33.0`; the repository uses Node 22
  images and declares pnpm `10.33.0`.
- Confirmed the planned isolated ports were not listening.
- Created the dedicated S6 branch and worktree from canonical
  `origin/main`.
- Added Node-runtime document middleware with a 128-bit per-request nonce,
  identical request/response CSP, revision fencing, conditional HSTS, and the
  required document security headers.
- Split legacy custom footer behavior into sanitized footer markup,
  structured verification, and a validated public integration registry.
- Added explicit legacy classification, read-only export/copy, safe migration,
  clear, rollout modes, and transactional revision changes.
- Derived video, Turnstile, public integration, and actual AWS-presigner S3/R2
  origins from their runtime configuration sources.
- Preserved the stricter file response policy, added JSON `nosniff`, and kept
  CORS/COEP absent.
- Browser validation proved that Next.js client navigation applies style
  attributes that cannot carry a nonce. Applied the handoff-approved
  `style-src 'self' 'unsafe-inline'` compatibility fallback only; production
  `script-src` remains nonce-based with no `unsafe-inline` or `unsafe-eval`.
- Added real-PostgreSQL migration tests and Playwright coverage for public,
  admin, login, Turnstile, integration script/connect/image, local media,
  rendered local and S3 video players, actual presigned S3 image/video
  redirects, strict download headers, session cookies, per-request nonce
  rotation, cross-scope full-document navigation, asset-looking HTML 404s, and
  legacy migration followed by a second save.
- Added the Playwright browser gate to CI with a dedicated migrated database.
- Verified all 130 test files and 1050 tests against the isolated real
  PostgreSQL database.
- Verified the production Docker image, standalone middleware runtime,
  per-request nonce rotation, JSON `nosniff`, conditional HSTS absence, and
  inclusion/syntax of all three one-off artifacts.
- Addressed the earlier independent review findings: executable legacy
  report-only handling; local-driver historical S3 sources; semantic legacy
  classification; migration collisions and stale clients; all three persisted
  rollout modes; health/ready headers; asset-looking 404 matcher boundaries;
  trusted header spoofing; active and historical storage origins; advisory
  locking; adapter registry cohesion; exact endpoint validation; public/admin
  CSP scope navigation; duplicate render-time scans; local and S3 rendered
  media coverage; and documentation consistency.
- Preserved legacy and safe-footer behavior across the complete historical
  `(site)` layout scope while restricting structured verification and
  integrations to public content documents.
- Preserved explicit or automatic Report-Only mode if optional storage-origin
  derivation fails, using same-origin storage sources instead of unexpectedly
  enforcing CSP.
- Added an expected-revision compare-and-swap under the advisory transaction
  lock. A stale admin save is rejected before any ordinary or security setting
  is written, and same-revision concurrent writers cannot both succeed.
- Replaced remaining public/sensitive CSP-scope client transitions with
  full-document navigation, including content-level membership and login
  links.
- Added rendered-layout revision-fence tests, two-tab stale-save browser
  coverage, click-driven login/checkout scope checks, and browser download
  response-chain checks.
- Three final fresh-context verifiers independently reviewed the latest
  complete working-tree diff for security/specification, browser/tests, and
  documentation/evidence. All three returned `CLEAN`.
- Committed and pushed the reviewed implementation as
  `e17e623b97dfca82043c88372c956b1811d9bef5`.
- Opened Draft PR #90 against canonical `main`; the PR closes #86, documents
  the exact scope/invariants/migration behavior/evidence/limitations, and
  explicitly excludes S7.
- GitHub Actions CI run `28289646888` completed successfully for the exact
  implementation commit. Its single `check` job passed install, static gates,
  migration, all tests, build, browser installation, isolated browser DB
  preparation, and the Playwright security scenario in 4m04s.

## Commands actually executed

All commands below exited 0 unless an explicit result says otherwise.

```text
pwd
git remote -v
git status --short --branch
git worktree list --porcelain
git rev-parse --show-toplevel
cat AGENTS.md
  exit 1 before canonical main was fetched: file absent on stale fork main
rg --files -g 'AGENTS.md' ...
  exit 127: rg is not installed
find .. -name AGENTS.md -type f -print
git fetch origin main
git fetch upstream main
git rev-parse origin/main
git rev-parse upstream/main
git log --oneline --decorate -12 origin/main
git log --oneline --decorate -12 upstream/main
git remote rename origin fork
git remote rename upstream origin
git fetch origin main
git show origin/main:AGENTS.md
git show origin/main:docs/handoff/harden-s6-security-response-headers.md
git show origin/main:docs/handoff/harden-s7-backup-consistency.md
git show origin/main:docs/release-v1.0-checklist.md
git ls-tree -r --name-only origin/main docs/adr
git grep -n -E 'ADR|adr/' origin/main -- <authoritative documents>
git show origin/main:docs/adr/0008-public-video-embeds.md
git show origin/main:package.json
git grep -n -E 'NODE_VERSION|node:[0-9]|pnpm@|corepack' origin/main -- ...
df -h /home/miku/OpenLayerlyPro /tmp
free -h
node --version
pnpm --version
docker version --format '{{.Client.Version}} {{.Server.Version}}'
docker system df
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}'
  Docker commands could not access /var/run/docker.sock
ss -ltnp
id
ls -l /var/run/docker.sock
getent group docker
git worktree add -b codex/s6-security-response-headers \
  /home/miku/OpenLayerlyPro-s6 origin/main
git -C /home/miku/OpenLayerlyPro-s6 status --short --branch
git -C /home/miku/OpenLayerlyPro-s6 rev-parse HEAD
find . -name AGENTS.md -type f -print
sudo -n docker compose -p openlayerlypro_s6_86 ...
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm check:request-bodies
pnpm exec tsc --noEmit
DATABASE_URL=postgresql://artist:artist_password@127.0.0.1:5433/openlayerlypro_s6_86_test \
  RUN_DB_INTEGRATION_TESTS=true pnpm test
  130 test files and 1050 tests passed
pnpm build:migrator
pnpm build:files-backfill
pnpm build:admin-reset
pnpm build
pnpm exec playwright install chromium
DATABASE_URL=postgresql://artist:artist_password@127.0.0.1:5433/openlayerlypro_s6_86_browser \
  ... pnpm test:e2e
  Early expanded-browser runs exposed and then resolved a translated link
  selector, localized conflict-message assertion, unsupported S3 download
  event expectation, and post-download navigation ordering.
  Final run: 1 browser test passed in 37.4 seconds.
sudo -n docker build --tag openlayerlypro:s6-86 .
sudo -n docker run --rm --entrypoint sh openlayerlypro:s6-86 ...
  all one-off artifacts are present and pass node --check
sudo -n docker run ... openlayerlypro:s6-86
curl --dump-header ... http://127.0.0.1:3002/
  standalone image returned the expected CSP and security headers, omitted
  HSTS when disabled, added JSON nosniff, and rotated the nonce
pnpm exec vitest run src/app/layout.test.tsx ...
  first run failed because the root CSS import reached the repository PostCSS
  plugin under Vitest; the test now mocks that import
pnpm exec vitest run <focused S6 unit files>
  5 test files and 35 tests passed
DATABASE_URL=... RUN_DB_INTEGRATION_TESTS=true \
  pnpm exec vitest run src/modules/site/public-security.integration.test.ts
  1 test file and 9 tests passed
pnpm lint
pnpm format:check
pnpm check:request-bodies
pnpm exec tsc --noEmit
git diff --check
  final static gate run passed
pnpm build:migrator
pnpm build:files-backfill
pnpm build:admin-reset
pnpm build
  final artifact and production builds passed
sudo -n docker build --tag openlayerlypro:s6-86 .
  final image build passed
sudo -n docker run --rm --entrypoint sh openlayerlypro:s6-86 ...
  final image artifacts and middleware are present; node --check passed
sudo -n docker run ... openlayerlypro:s6-86
curl ... http://127.0.0.1:3002/
  final standalone smoke passed with nonce rotation and required headers
git commit -m "feat(security): add nonce-based response headers"
  e17e623b97dfca82043c88372c956b1811d9bef5
git push -u origin codex/s6-security-response-headers
GitHub Draft PR creation
  https://github.com/39mikuu/OpenLayerlyPro/pull/90
gh run watch 28289646888 --repo 39mikuu/OpenLayerlyPro --exit-status
  CI passed on e17e623b97dfca82043c88372c956b1811d9bef5
```

## Open reviewer findings

None. Multiple read-only review waves reported actionable findings and all
were fixed. The final fresh security/specification, browser/tests, and
documentation/evidence verifiers each returned `CLEAN`.

## Blockers

- The S6 human merge gate is active. This is an intentional sequencing gate,
  not an implementation failure.
- Docker access is available through non-interactive `sudo -n docker`.
- `rg` is unavailable; repository inspection uses `git grep`, `find`, and
  other non-mutating fallbacks.

## Next permitted action

Wait for a human to review and merge Draft PR #90. Do not mark it Ready, merge
it, or begin S7 autonomously.

## Human gates still required

- Human merge of the future S6 Draft PR before S7 may begin.
- Human merge of the future S7 Draft PR before v1.0 acceptance may begin.
- Human authorization after review of the final release-candidate report
  before tag or GitHub Release publication.
