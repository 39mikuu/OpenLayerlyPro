# Mail Settings

Admin path: `/admin/settings`

SMTP is required for production fan email-code login and for transactional notifications. SMTP configuration can come from encrypted admin settings or the documented environment fallback; all mail paths use the same resolved configuration.

## Used For

- login verification codes;
- membership activation and revocation notifications;
- payment rejection notifications;
- manual renewal reminders;
- SMTP test emails.

## Configuration and Secret Handling

- SMTP passwords are stored through encrypted admin config when configured in the dashboard.
- Admin read APIs return only masked/set-state information, never the password.
- Do not commit SMTP credentials to `.env` or expose them through `NEXT_PUBLIC_*` variables.
- Development mode may log verification codes only when SMTP is not configured. Production does not use this fallback.

## Recipient Data Boundary

Durable transactional email tasks use v2 payloads with business references such as `paymentRequestId`, `membershipId`, `subscriptionId`, and `periodEndsAt`. They must not store `tasks.payload_json.to`; the worker dereferences the latest user email and locale at send time, then revalidates business freshness before SMTP.

Operators can assert the boundary with:

```sql
select count(*)
from tasks
where kind = 'email'
  and payload_json ? 'to';
```

The expected count is zero. Historical terminal rows are redacted with `recipientRedacted=true`; unsafe retryable legacy rows are dead-lettered with a safe error.

The admin task API/UI, application logs, delivery ledger, and normalized provider errors must not expose raw recipient addresses, verification codes, SMTP secrets, or raw provider responses.

## Reliable Delivery Semantics

Business email is delivered through durable tasks rather than best-effort inline sends:

- task enqueue happens in the same database transaction as the business state change;
- provider failures are classified as transient, permanent, or requiring operator action;
- missing/broken SMTP does not return a fake success for business mail;
- operator-blocked business mail defers without consuming attempts, then becomes dead after the configured maximum age;
- every send uses a stable Message-ID derived from the logical delivery identity;
- the delivery ledger records accepted/failed outcomes without storing raw provider errors or secrets;
- admins can inspect failed/dead work and explicitly retry eligible deliveries.

Login-code mail has a short TTL and different failure handling: when it cannot be delivered in time, it becomes permanently failed and the user requests a new code.

## Stale and Cancellation Guards

Mail tasks that can become obsolete must re-check their current business state immediately before SMTP:

- a superseded login code succeeds as a no-op and never sends the old code;
- a canceled/renewed/stale renewal reminder succeeds as a no-op;
- restored or retried work must not send a notification whose state can no longer be verified.
- restore neutralization dead-letters nonterminal payment/membership transactional email tasks and bulk notification task kinds when the delivery outcome is unknown; renewal reminders may re-arm only with a v2 subscription/period reference and still revalidate freshness.

These checks occur outside long database transactions. The task claim/fence is captured in a short transaction, SMTP runs afterward, and only the current claim may commit the final task/delivery state.

## At-Least-Once Residual

SMTP does not provide exactly-once delivery. If the provider accepts a message and the worker crashes before the database records success, lease recovery may send the same logical message again. Stable Message-ID and the delivery ledger improve traceability but cannot eliminate mailbox/provider duplicates.

Bulk post notifications are opt-in by default off. They render in the recipient's current locale, skip archived/unpublished posts at send time, and write suppression records only for synchronous permanent SMTP rejection from notification delivery. Suppression does not affect login codes, payment emails, membership emails, or renewal reminders.

Operators should monitor the task dashboard, deferred/dead counts, and delivery ledger rather than treating task enqueue as proof of inbox arrival.
