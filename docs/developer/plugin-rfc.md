# Plugin RFC（已取消）

OpenLayerlyPro no longer plans a generic third-party plugin runtime.

## Current Decision

- A first-party Integration registry exists for SMTP, Storage, Turnstile, Tunnel, Stripe, and Translation status/test boundaries.
- A first-party `PaymentProvider` adapter boundary is implemented and used by Stripe one-time Checkout and subscriptions.
- Translation uses an admin-only OpenAI-compatible provider abstraction.
- No third-party plugin loading or execution runtime is planned.
- No plugin marketplace or Hub runtime is planned.
- Storage and theme registration points remain internal first-party architecture, not installable plugin APIs.

The existing adapters must not be described as a general plugin system: they are compiled into the trusted application and do not provide installation, isolation, capability negotiation, or third-party lifecycle management.

## Rationale

Generic plugins would require a durable capability model, secret isolation, install/update lifecycle, failure isolation, compatibility guarantees, audit logging, and a much larger test matrix. That complexity is too high for the current single-creator self-hosted product direction.

Future extensions should be designed as first-party Core / Theme / Integration features with explicit product scope and normal release validation.
