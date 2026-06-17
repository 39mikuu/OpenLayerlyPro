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
- public chrome and mobile navigation

## Rules

- Use existing view models and i18n dictionaries.
- Do not hard-code bilingual labels.
- Do not add fake features such as likes, follows, search, filters, or comments.
- Keep custom CSS scoped to public theme surfaces.
- Admin pages remain independent of theme.
