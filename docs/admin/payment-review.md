# Payment Review

OpenLayerlyPro v0.1 uses manual screenshot payment review.

## Flow

1. Fan selects a membership tier.
2. Fan pays through an external method configured by the creator.
3. Fan uploads a payment proof image.
4. Admin reviews the request.
5. Approval grants membership automatically.
6. Rejection sends the fan back to resubmit proof when appropriate.

## Boundaries

- v0.1 does not include automatic payment providers.
- v0.1 does not include webhooks.
- Payment proofs are private files and are not public assets.
- Review actions require admin access.
