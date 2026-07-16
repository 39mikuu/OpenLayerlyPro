# Theme Development

The builtin theme renders public surfaces only. It must not control admin login, admin dashboard, payment review, or other admin workflows.

## Current Public Surfaces

- home
- posts list
- post detail
- tiers
- checkout/payment proof
- fan login
- account
- orders
- supporter wall (`/supporters`)
- public chrome and mobile navigation

## Required Component Contract

Every statically registered theme must implement every `ThemeComponents` slot, including the
WP5 `SupporterWall` slot. It receives a `SupporterWallViewModel` and the shared translator from
Core. The route and Core module derive eligibility from current membership, opt-in, display name,
minimum level, and moderation state on every request.

Theme code must only render that view model. It must not query supporter entries, memberships,
settings, users, or email addresses, and it must not cache the final supporter list. Render display
names, tier names, and dedications as plain text; do not linkify URLs or inject HTML. All three
built-in themes (`builtin`, `blog`, and `wordpress`) implement the same mandatory slot.

## Rules

- Use existing view models and i18n dictionaries.
- Do not hard-code bilingual labels.
- Do not add fake features such as likes, follows, search, filters, or comments.
- Keep custom CSS scoped to public theme surfaces.
- Keep valid long display names, tier names, and dedications inside mobile layouts.
- Admin pages remain independent of theme.
