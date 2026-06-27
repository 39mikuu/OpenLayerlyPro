# Plugin RFC

Third-party plugin execution remains future work and is not part of the v1.0 release path.

## Current Status

- A first-party Integration registry exists for SMTP, Storage, Turnstile, Tunnel, Stripe, and Translation status/test boundaries.
- A first-party `PaymentProvider` adapter boundary is implemented and used by Stripe one-time Checkout and subscriptions.
- Translation uses an admin-only OpenAI-compatible provider abstraction.
- There is no third-party plugin loading or execution runtime.
- There is no plugin marketplace or Hub runtime.
- Storage and theme registration points are internal first-party architecture, not installable plugin APIs.

The existing adapters must not be described as a general plugin system: they are compiled into the trusted application and do not provide installation, isolation, capability negotiation, or third-party lifecycle management.

## Future Direction

Potential plugin areas:

- additional payment providers
- translation providers
- storage providers
- theme packages
- analytics integrations

Security requirements before plugin runtime:

- explicit capability model
- secret isolation
- clear admin install/update flow
- no visitor-triggered creator cost by default
- audit logging for plugin actions
