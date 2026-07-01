# Issue #102 — reconcile / webhook clock ordering (validation report)

- **Baseline:** `e08363ab988785cc510ea1900f7e2c178bf14cf8` (validated on the current `main`, unchanged code path).
- **Classification result:** **CONFIRMED user-visible incorrect state.**
- **Reproduction:** `src/modules/payment/reconcile-webhook-clock.integration.test.ts` (real PostgreSQL, drives the production `reconcileSubscriptions`, `persistPaymentProviderEvent`, and `dispatchPaymentProviderEvent`).
- **Production change in this branch:** none. Reproduction test + this report only.

## Root cause

`reconcileSubscriptions()` (`src/modules/payment/subscriptions.ts:943-953`) writes the latest
remote `status`, `currentPeriodEndsAt`, and `cancelAtPeriodEnd`, and bumps `updatedAt`, but it
does **not** set `statusEventAt`.

Every webhook apply path gates its write on:

```
statusEventAt IS NULL OR statusEventAt <= providerCreatedAt
```

(`applySubscriptionActivated`, `applySubscriptionPaymentFailed`, `applySubscriptionCanceled`,
`updateSubscriptionFromPaidInvoice`). Because reconcile leaves `statusEventAt` at its stale value,
a webhook that was **delayed in flight** — with a semantically older status but a
`providerCreatedAt` still newer than that stale `statusEventAt` — passes the gate and overwrites
the fresher state reconcile just pulled.

## Interleaving (test 2: `payment_failed` clobber)

Initial row: `status=past_due`, `statusEventAt=T0 (2026-01-01)`, `currentPeriodEndsAt=2025-12-01`,
`providerSubscriptionRef=sub_123`.

Provider truth at reconcile time: `retrieveSubscription -> { status: active, currentPeriodEndsAt: 2026-02-01, cancelAtPeriodEnd: false }`.

| Step | Action | Resulting row |
| --- | --- | --- |
| T-reconcile | `reconcileSubscriptions()` pulls remote truth | `status=active`, `currentPeriodEndsAt=2026-02-01`, **`statusEventAt=T0` (unchanged)** |
| T1 (`2026-01-10`, `T0 < T1 < reconcile`) | delayed `subscription_payment_failed` webhook (`providerCreatedAt=T1`) dispatched | gate `T0 <= T1` passes → `status=past_due`, `statusEventAt=T1` |

- **最终本地状态:** `past_due`, `currentPeriodEndsAt=2026-02-01`
- **期望状态:** `active` (remote truth)
- **是否产生用户可见错误:** **是** — an entitled member is locally marked `past_due` and loses
  access, and the row is internally inconsistent (`status=past_due` while `currentPeriodEndsAt`
  points at an active future period).

Test 3 reproduces the same clobber with a delayed `subscription_canceled` event (local `canceled`
while remote is `active` — full loss of subscription locally).

## Control (test 4) — isolates the cause

Repeating test 2 but manually advancing `statusEventAt` to the reconcile time (the candidate fix)
makes the gate reject the stale webhook; the reconciled `active` state survives. This confirms the
missing `statusEventAt` advance is the sole cause.

## Blast radius

- Trigger requires a webhook delivery delayed until after a reconcile pass that pulled a newer
  state (Stripe retries / at-least-once delivery make this reachable in production).
- Any of `past_due`, `canceled` can be written over a reconciled `active`; the reverse (older
  `active` over a newer `canceled`) is equally possible.
- No data loss beyond the subscription row's status/period consistency, but it is directly
  member-facing (access granted/revoked incorrectly).

## Fix (implemented — issue #112, this PR)

`reconcileSubscriptions()` now advances `statusEventAt` under the same monotonic guard the webhooks
use, in a **single provider clock domain**, and protects the external-I/O race with a version CAS:

1. **Provider clock domain.** `retrieveSubscription()` now returns `observedAt`, the provider server
   clock at which the state was observed (the Stripe API response `Date` header). reconcile advances
   `statusEventAt` to `observedAt` — the same clock domain as webhook `providerCreatedAt` — rather
   than local `now()`, so clock skew cannot wrongly reject a genuinely later provider event.
2. **Version CAS.** The reconcile write is guarded by `WHERE version = <version read before the
   provider call>` in addition to `statusEventAt IS NULL OR statusEventAt <= observedAt`. A webhook
   that commits while `retrieveSubscription()` is in flight bumps `version`, so the reconcile write
   matches no rows and is skipped instead of clobbering the fresher webhook state.

The regression suite (`reconcile-webhook-clock.integration.test.ts` in the fix PR) asserts the
surviving correct state: advance to the observation timestamp; reject delayed older
`payment_failed`/`canceled` webhooks; accept a genuinely newer webhook; and a CAS case proving an
in-flight webhook commit survives.

This reproduction PR's assertions intentionally encode the *pre-fix* buggy behavior, so it is
superseded by the fix PR and closed rather than merged; this document is retained as the evidence
record.

## v1.0 impact

Release-blocking correctness defect for Stripe subscription entitlements. Recommend fixing before
v1.0 leaves HOLD.
