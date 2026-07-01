# Issue #103 — concurrent first-time initialization (validation report)

- **Baseline:** `e08363ab988785cc510ea1900f7e2c178bf14cf8` (validated on the current `main`, unchanged code path).
- **Classification result:** **No concurrent data-integrity defect; setup must still be completed
  before public exposure.** The three concerns are distinct and must not be conflated:
  - **Concurrency integrity — confirmed safe.** No unintended admin, no partial initialization;
    exactly one transaction commits. No locking/token mechanism is required for correctness.
  - **Losing caller may receive 500 instead of 403 — non-blocking error semantics.** A cosmetic
    wart, not a correctness or security issue.
  - **Pre-setup public exposure — operational deployment boundary.** Unchanged by this analysis;
    the setup route is public until initialized, so completing setup before the site is exposed
    remains a documentation/checklist requirement, not something the concurrency behavior removes.
- **Reproduction:** `src/modules/site/concurrent-setup.integration.test.ts` (real PostgreSQL).
- **Production change in this branch:** none. Reproduction test + this report only.

## Race surface

`setupSite()` (`src/modules/site/index.ts:175-217`) checks `isInitialized()` **before** its
transaction and never rechecks inside it. Two concurrent callers can both pass the precheck. Inside
the transaction it: (1) upserts the admin user by email, (2) `INSERT`s the three default membership
tiers, (3) upserts `initialized=true` and the site settings — all atomically.

## What actually serializes the callers

The default tiers are inserted with fixed slugs (`supporter`, `hd-member`, `pack-member`), and
`membership_tiers.slug` is `UNIQUE` (`users.email` is also `UNIQUE`). When two transactions race:

- The second transaction to reach the tiers `INSERT` blocks on the first (same slug), then, once
  the first commits, fails with a `duplicate key value violates unique constraint` error and the
  **entire second transaction rolls back** (PostgreSQL statement failure aborts the transaction).

So exactly one caller's transaction persists. Because each caller's work is a single atomic
transaction, the loser leaves **no partial state** — its admin user, its tiers, and its
`initialized` write are all rolled back together.

## Deterministic barrier reproduction (test 3)

Two reserved connections force the dangerous window:

| Step | c1 (admin A) | c2 (admin B) |
| --- | --- | --- |
| 1 | `BEGIN` | `BEGIN` |
| 2 | `SELECT initialized` → none (precheck passes) | `SELECT initialized` → none (precheck passes) |
| 3 | insert user A (admin), 3 tiers, `initialized=true` | — |
| 4 | `COMMIT` | insert user B, then tiers `INSERT` → **unique violation** |
| 5 | — | `ROLLBACK` |

**Resulting database state:** one admin (`A`), exactly 3 tiers, `initialized=true`; admin `B` was
never persisted. Verified by assertions.

## Answers to the issue's required questions

- **Only one transaction succeeds?** Yes — enforced by `membership_tiers.slug` (and `users.email`) unique constraints.
- **How is the winner determined?** First transaction to commit the default-tiers insert.
- **Partial tiers/settings initialization?** No — single atomic transaction per caller.
- **Unintended administrator created/promoted?** No. Different emails: the loser's admin insert is
  rolled back, so only the winner's admin exists. Same email: `onConflictDoUpdate` + rollback still
  yield a single admin row for that email.
- **Same vs different email:** both converge to exactly one admin, one tier set, `initialized=true`
  (tests 1 and 2).
- **Exploitable public deployment window?** The real exposure is that the setup endpoint is
  **public until initialized** — i.e. the first caller (concurrent or not) becomes admin. This is
  inherent to unauthenticated bootstrap, not introduced by concurrency; concurrency does not widen
  it. Mitigation is operational: initialize immediately on deploy and/or keep the setup route
  unreachable publicly during the bootstrap window.

## Minor finding (non-blocking)

When two callers truly overlap, the losing caller can surface an **unmapped unique-violation error
(HTTP 500)** instead of a clean `403 siteInitialized`. This is a UX wart, not a correctness or
security issue. Optional future polish: map a concurrent-loser unique violation in `setupSite()` to
`ApiError(403, "siteInitialized")`. Not required for v1.0 correctness.

## Decision-option evaluation (nothing implemented)

- **PostgreSQL advisory lock / transaction-local recheck / bootstrap token:** not required for
  correctness — the unique constraints already guarantee single-admin, no-partial-init. Any of these
  would only improve the loser's error message, which the optional mapping above achieves more
  cheaply.
- **Documented deployment precondition:** recommended, and now **landed** — the operator requirement
  (keep the instance, Cloudflare Tunnel, and reverse proxy non-public until first setup completes and
  `/admin/setup` is confirmed closed) is added as a concrete gate in `docs/release-v1.0-checklist.md`
  (§5, Deployment). It is a docs/ops item, not a code change.

## v1.0 impact

**Not release-blocking as a concurrency defect.** Recommend closing #103's data-integrity concern as
"not a defect" (keep the reproduction as a regression guard). The pre-setup public-exposure boundary
is not removed by this analysis and is tracked as a v1.0 acceptance gate in the release checklist
(§5). The losing-caller 500-vs-403 error-message polish is an optional non-blocking follow-up.
