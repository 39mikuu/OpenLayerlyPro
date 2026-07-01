# Issue #102 — reconcile / webhook clock ordering (validation report)

- **Baseline:** `e08363ab988785cc510ea1900f7e2c178bf14cf8` (validated on the current `main`, unchanged code path).
- **Classification result:** **CONFIRMED user-visible incorrect state.**
- **Reproduction:** `src/modules/payment/reconcile-webhook-clock.integration.test.ts` (real PostgreSQL, drives the production `reconcileSubscriptions`, `persistPaymentProviderEvent`, and `dispatchPaymentProviderEvent`).
- **Production change in this branch:** implemented under #112; this report records the reproduced defect and final ordering design.

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

Repeating test 2 but advancing `statusEventAt` to the provider observation fence makes the gate
reject the stale webhook; the reconciled `active` state survives. This confirms the missing
reconcile fence advance is the root cause.

## Blast radius

- Trigger requires a webhook delivery delayed until after a reconcile pass that pulled a newer
  state (Stripe retries / at-least-once delivery make this reachable in production).
- Any of `past_due`, `canceled` can be written over a reconciled `active`; the reverse (older
  `active` over a newer `canceled`) is equally possible.
- No data loss beyond the subscription row's status/period consistency, but it is directly
  member-facing (access granted/revoked incorrectly).

## Fix (implemented — issue #112, this PR)

`reconcileSubscriptions()` now advances `statusEventAt` in a **single provider clock domain** using a
strict monotonic guard — no version CAS and no local-time fallback:

1. **Provider clock domain.** Stripe exposes the API response `Date` header as `observedAt`. Production
   `getPaymentProvider()` normalizes that coarse second-granularity value to the end of the represented
   provider second (`.999`). The resulting value is an observation fence, still entirely in the Stripe
   clock domain.
2. **Fail closed on a missing timestamp.** `observedAt` is `Date | null`; when Stripe omits or returns
   an unparseable `Date` header, reconcile skips the status/fence write rather than substituting local
   time. Adapter tests cover valid, missing, and invalid headers.
3. **Strict `<` live-row guard.** Reconcile writes only when the current fence is null or strictly
   older than the provider observation fence. A webhook from a later provider second therefore
   survives an in-flight reconcile, while an older webhook cannot beat a later provider observation.
   No version CAS is used, because commit timing must not override provider-clock ordering.
4. **Same-second ambiguity policy.** Stripe webhook `event.created` and HTTP `Date` are both only
   second-granularity, so their true sub-second order is unknowable. The deterministic fail-closed
   policy is that the provider observation owns the represented second: the fence is stored at
   `.999`, so a same-second webhook cannot directly overwrite it. A genuinely later change from that
   same second is recovered by the next durable provider reconcile; an event from the next provider
   second is accepted normally. This preserves existing webhook-vs-webhook equality behavior because
   only reconcile fences carry the fractional end-of-second marker.
5. **Reconciled paid invoices remain on provider time.** `listPaidSubscriptionInvoices()` no longer
   stamps reconstructed events with local `new Date()`. It uses Stripe
   `status_transitions.paid_at`, falling back only to the provider invoice `created` timestamp. This
   closes the alternate path that could otherwise reintroduce a local-time value into
   `statusEventAt` after the subscription observation write.

The regression suite asserts: advance through the provider observation second; reject delayed older
`payment_failed`/`canceled` webhooks; accept a next-second webhook; reject an ambiguous same-second
webhook; converge that same-second change on the next provider observation; preserve an in-flight
next-second webhook; let an in-flight same-second webhook lose to the observation fence; fail closed
on null `observedAt`; prevent an older reconciled paid invoice from regressing a newer fence; and use
Stripe paid/created timestamps for reconstructed invoice events.

PR #109's assertions intentionally encoded the pre-fix buggy behavior, so it was closed rather than
merged; this document is retained as the evidence record in the fix PR.

## v1.0 impact

Release-blocking correctness defect for Stripe subscription entitlements. Fix before v1.0 leaves
HOLD.
