# Payments and Review

OpenLayerlyPro supports two one-time payment paths that can coexist:

- manual payment proof review
- optional Stripe-hosted card checkout

## Manual review flow

1. Fan selects a membership tier.
2. Fan pays through an external method configured by the creator.
3. Fan uploads a payment proof image.
4. Admin reviews the request.
5. Approval grants membership and enqueues the activation email in the same transaction.
6. Rejection allows proof resubmission when appropriate.

## Stripe one-time checkout flow

1. Creator enables and configures Stripe from `/admin/settings`.
2. Fan selects a payable membership tier and starts checkout.
3. OpenLayerlyPro creates a Stripe-hosted Checkout Session and redirects the fan to Stripe.
4. Returning to the success URL does not activate membership by itself.
5. Only a valid signed `checkout.session.completed` webhook with `payment_status=paid` can approve the request and grant membership.
6. Replayed webhook events are idempotent, and Checkout Session creation uses the stable key `checkout:<requestId>`.
7. A signed `checkout.session.expired` event cancels a request that is still `pending_payment`.

## Boundaries

- v0.2 supports Stripe one-time card payments only; subscriptions and automatic renewals are not included.
- Refund, chargeback, and reconciliation automation are not included in v0.2.
- The manual screenshot flow remains available when Stripe is disabled or not suitable for the deployment.
- Payment proofs are private files and are never public assets.
- Manual review actions require admin access.
- Stripe webhook processing requires signature verification and does not trust browser redirects.
