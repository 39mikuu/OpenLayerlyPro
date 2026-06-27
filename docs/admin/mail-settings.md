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

Durable email tasks currently store the recipient address in `tasks.payload_json.to` so the worker can send after the business transaction commits. The task table is therefore sensitive operational data and must be protected by the same database access controls, backup controls, and retention discipline as user records.

The admin task API/UI, application logs, delivery ledger, and normalized provider errors must not expose raw recipient addresses, verification codes, SMTP secrets, or raw provider responses. This is a presentation/logging redaction boundary; it does not mean the underlying task payload is de-identified.

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

These checks occur outside long database transactions. The task claim/fence is captured in a short transaction, SMTP runs afterward, and only the current claim may commit the final task/delivery state.

## At-Least-Once Residual

SMTP does not provide exactly-once delivery. If the provider accepts a message and the worker crashes before the database records success, lease recovery may send the same logical message again. Stable Message-ID and the delivery ledger improve traceability but cannot eliminate mailbox/provider duplicates.

Operators should monitor the task dashboard, deferred/dead counts, and delivery ledger rather than treating task enqueue as proof of inbox arrival.
