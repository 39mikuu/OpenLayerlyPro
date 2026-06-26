# Payments, Subscriptions, and Review

OpenLayerlyPro supports three membership payment paths that can coexist:

- manual payment proof review;
- optional Stripe-hosted one-time card checkout;
- optional Stripe recurring subscriptions.

Deployments without recurring card support can also enable manual renewal reminders, which send period-scoped reminders and then reuse the existing manual/one-time purchase paths.

## Manual review flow

1. Fan selects a membership tier.
2. Fan pays through an external method configured by the creator.
3. Fan uploads a payment proof image.
4. Admin reviews the request.
5. Approval grants membership and enqueues the activation email in the same transaction.
6. Rejection/resubmission/cancellation follows the payment-request state machine and audit rules.
7. Proof files remain private and follow the configured retention, cleanup, quota, and resubmit lifecycle.

Concurrent manual/automatic pending requests are serialized and protected by a partial unique constraint; the system does not silently keep two pending requests for the same user/tier identity.

## Stripe one-time checkout

1. Creator enables and configures Stripe in `/admin/settings`.
2. Fan starts a one-time Checkout Session (`mode=payment`).
3. Browser success/cancel redirects do not change membership by themselves.
4. A valid signed paid `checkout.session.completed` event is persisted to the provider-event inbox and later processed by the internal dispatcher.
5. Amount/currency and local ownership are validated before the payment request is approved and membership is granted.
6. Session creation uses stable idempotency key `checkout:<requestId>` and stale `creating:*` claim recovery.
7. `checkout.session.expired` cancels a still-pending one-time request.

## Stripe recurring subscriptions

1. A subscribable tier has a configured Stripe recurring Price reference.
2. The system creates a local `subscriptions` row before external Checkout and uses stable idempotency key `subscription-checkout:<subscriptionId>`.
3. Stripe Checkout runs in `mode=subscription`; local subscription metadata is attached to the Session and Stripe Subscription.
4. `customer.subscription.created` / `.updated` synchronize provider/customer refs, status, period end, and cancel-at-period-end state.
5. Each paid subscription invoice is a distinct financial object. `invoice.paid` selects the matching configured price line and grants exactly the Stripe line period; it does not extend from `now`.
6. Invoice identity is unique per provider, so webhook/reconcile repeats cannot create a second payment request or membership period.
7. `invoice.payment_failed` records the failed renewal state without inventing a paid membership period.
8. `customer.subscription.deleted` records cancellation. A user-requested period-end cancellation does not revoke already paid time.
9. Reconciliation can retrieve the Stripe subscription and paid invoices, then reuse the same invoice application path.

## Refunds and disputes

- A full `charge.refunded` event reverses the matching one-time payment or subscription invoice period.
- `charge.dispute.created` follows the same target-resolution path with a distinct audit action.
- Stripe dispute objects may not carry invoice directly; the provider resolves PaymentIntent → Charge → Invoice when required.
- Refund/dispute can arrive before paid. The system persists a reversal-first tombstone by invoice/payment identity; a later paid event may fill references but cannot grant membership.
- Reversing a subscription invoice revokes only the membership row granted for that invoice period. Other paid periods and manual grants are preserved.
- Partial refunds are ignored by the automatic full-reversal policy; they do not proportionally change membership access.
- Provider event IDs, raw dispute details, secret values, and unfiltered provider errors are not placed in user-facing notifications.

## Provider-event inbox and dispatcher

The webhook route verifies the signature, normalizes the event, persists it with a unique provider event ID, enqueues/links its dispatch task, and returns 2xx after durable ownership is obtained. Business processing happens through the internal dispatcher:

- event and task each have status/lease/attempt tracking;
- business changes, audit/outbox, and final event state commit in one transaction;
- random claim tokens and fencing prevent a stale worker from committing;
- event ID deduplicates delivery, while Checkout/invoice/payment identities deduplicate financial effects;
- failed/dead events are visible for operator retry; Stripe redelivery is not the only recovery mechanism.

## Stripe webhook configuration

Enable these events for the OpenLayerlyPro webhook endpoint:

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `charge.refunded`
- `charge.dispute.created`

OpenLayerlyPro marks owned Stripe objects with local metadata. Events from unrelated products in the same Stripe account are ignored unless they resolve to an existing OpenLayerlyPro request/subscription through persisted references.

## Manual renewal reminders

Manual reminders use `subscriptions.provider = NULL` and a period-scoped durable task. The reminder period advances in the same membership-grant transaction using the latest eligible membership end. The handler does not schedule an unbounded future chain by itself.

Before sending, the reminder flow re-checks current subscription state and period identity. Cancellation, renewal, or stale work after enqueue must result in a safe no-op rather than sending an obsolete reminder.

## Boundaries

- Stripe currently supports card Checkout through the implemented provider adapter; adding another payment provider requires the same idempotency, inbox, period, refund, and reconciliation contracts.
- Only full refunds and dispute creation automatically disable the corresponding paid period. Partial refunds and dispute-won restoration require an explicit policy/manual action.
- Manual proof review remains available when Stripe is disabled or unsuitable.
- Payment proofs are private files and are never public assets.
- Manual review and provider retry actions require admin access.
- Webhook processing requires signature verification and never trusts browser redirects.
