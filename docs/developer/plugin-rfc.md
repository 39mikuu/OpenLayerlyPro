# Plugin RFC

Plugin runtime is future work and is not included in v0.1.

## v0.1 Status

- Integration registry exists for first-party integrations.
- No third-party plugin execution runtime.
- No plugin marketplace.
- No payment provider adapter runtime.

## Future Direction

Potential plugin areas:

- automatic payment providers
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
