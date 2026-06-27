Purpose

This file defines mandatory repository-wide instructions for AI coding agents working on OpenLayerlyPro.

Follow the current task specification, accepted ADRs, handoff documents, and existing repository behavior. Do not treat this file as permission to expand the scope of a task.

Repository and workspace safety
Operate only on the OpenLayerlyPro repository explicitly assigned by the user.
Before modifying files, verify:
repository root;
Git remote;
current branch;
current HEAD;
worktree status;
uncommitted changes.
Use a dedicated branch and isolated worktree for each independent issue or pull request.
Do not reuse or modify another task's worktree.
Do not discard, reset, overwrite, stash, or commit changes belonging to another task.
Keep Docker Compose project names, test databases, ports, and temporary directories isolated when multiple worktrees are active.
Check available disk space before dependency installation, container builds, or full test runs.
Sources of truth

Before implementation, read all applicable sources of truth:

the current user instruction;
the referenced GitHub issue or pull-request review;
accepted ADRs under docs/adr/;
the applicable implementation handoff under docs/handoff/;
current code and tests on the correct base branch.

When these sources conflict:

do not silently choose one;
determine whether one source is newer or explicitly authoritative;
preserve accepted safety invariants;
report material unresolved conflicts before making broad architectural changes.

Do not rely only on PR descriptions, implementation summaries, or existing tests.

Scope control
Implement only the requested issue, review follow-up, or roadmap slice.
Do not implement adjacent roadmap items opportunistically.
Do not mix unrelated refactors, dependency upgrades, formatting churn, or documentation rewrites into the change.
Do not change an accepted ADR unless the task explicitly requires an ADR update.
Prefer the smallest complete change that satisfies the authoritative specification.
When an out-of-scope defect is discovered, record it separately instead of silently expanding the current task.
Engineering requirements
Preserve TypeScript strictness.
Follow the repository's existing architecture and naming conventions.
Reuse established modules and infrastructure instead of creating parallel abstractions without justification.
Do not weaken validation, authorization, rate limiting, auditability, idempotency, transaction boundaries, or task fencing to simplify implementation.
Do not place external network, SMTP, object-storage, or unrelated database operations inside transactions or advisory-lock critical sections unless the authoritative design explicitly requires it.
Treat retries, duplicate delivery, stale workers, concurrent requests, partial failure, cancellation, and process crashes as normal execution conditions.
Avoid logging secrets, tokens, verification codes, payment credentials, raw provider errors, or sensitive personal data.
Never expose sensitive database payloads through logs or unauthorized administrative responses.
Database and concurrency

For changes involving PostgreSQL, tasks, payments, memberships, subscriptions, files, authentication, or other concurrent state:

identify the required invariants before editing code;
trace transaction and lock boundaries explicitly;
preserve idempotency and stale-operation behavior;
verify rollback behavior;
test duplicate, concurrent, stale, retry, and partial-failure paths where applicable;
use real PostgreSQL integration tests for behavior that depends on PostgreSQL semantics;
do not claim concurrency correctness based only on mocks or in-memory tests.
File and external-side-effect safety

Before deleting or invalidating a shared resource:

check every supported reference path;
perform reference checks and database mutation in the required transaction;
make storage deletion retryable and idempotent;
avoid leaving live database rows pointing to deleted files.

Before sending email or performing another irreversible external side effect:

revalidate freshness and cancellation conditions at the last safe point;
prevent stale durable tasks from carrying out invalidated actions;
preserve deduplication and retry guarantees.
Testing and verification

Use the exact scripts defined by the current repository configuration. Do not invent substitute commands when an established script exists.

For every implementation:

run focused tests for the changed behavior;
run relevant real-PostgreSQL integration tests when database behavior is involved;
run the repository-required formatting check;
run lint;
run TypeScript checking;
run the production build;
run the required full test suite before declaring the PR ready for review.

A test result is valid only when the command was actually executed and completed successfully.

Do not:

say a test “should pass”;
conceal skipped tests;
replace a required integration test with mocks;
modify or delete a valid test merely to make CI green;
claim success after a timeout, infrastructure failure, or truncated output.

Report the command, exit status, and meaningful result for every required check.

Independent review

The implementing agent must not be the sole reviewer of its own work.

After implementation and initial verification:

review the complete diff against the base branch;
use a fresh, read-only reviewer context or reviewer subagent when available;
give the reviewer the task specification, ADRs, handoff documents, base branch, and complete diff;
do not use the implementer's summary as proof of correctness;
review specifically for:
specification violations;
correctness defects;
authorization or data-exposure defects;
transaction and concurrency races;
stale-task and retry defects;
destructive file-lifecycle behavior;
missing regression tests;
documentation and implementation inconsistencies.

After findings are fixed, use a fresh verifier to review the complete resulting diff again.

Do not invent findings merely to produce a non-empty review.

Git and pull-request policy

Unless the user explicitly instructs otherwise:

do not merge;
do not mark a pull request Ready for review;
do not close issues;
do not create releases or tags;
do not modify production systems;
do not force-push;
do not rewrite shared branch history;
do not delete remote branches.

Keep commits focused and reviewable.

A pull request must accurately state:

its scope;
associated issue;
important design decisions;
tests actually executed;
known limitations or remaining risks.
Documentation

When behavior or operational requirements change:

update all directly affected authoritative documentation;
keep README, deployment, architecture, backup, security, ADR, handoff, and roadmap statements mutually consistent;
distinguish current implementation from planned behavior;
do not document behavior that has not been implemented and verified.

Documentation-only changes must still be checked against actual code, scripts, environment precedence, and deployment behavior.

Definition of done

A task is not complete merely because code was written or tests passed.

Completion requires:

requested scope is fully implemented;
authoritative invariants are preserved;
relevant tests exist;
required verification commands actually pass;
complete diff has been independently reviewed;
blocking findings are resolved;
documentation matches implementation;
branch and PR state match the user's instructions;
remaining risks and unexecuted checks are stated explicitly.
Final report

At the end of a task, report:

repository and worktree used;
branch name;
HEAD commit;
files or areas changed;
implementation summary;
tests and checks actually executed, with outcomes;
independent review outcome;
unresolved risks or blockers;
pull-request status;
whether any required verification was not completed.

Never hide incomplete work behind a confident summary.
