# Translation Settings

Admin path: `/admin/settings`

AI translation is optional and disabled by default.

## Provider

The current version supports an OpenAI-compatible chat completions provider configured through the admin dashboard:

- endpoint;
- model;
- API key;
- optional `monthlyCharLimit` setting;
- direct publish policy;
- machine translation label policy.

The API key is stored encrypted and is never returned in admin API responses.

## Important Cost Limitation

`monthlyCharLimit` is currently a stored/displayed configuration field only. The runtime does **not** maintain a monthly usage ledger, reserve characters before provider calls, or reject generation when that value is reached. It must not be relied on as a hard budget or spending cap.

Until an auditable quota implementation exists, configure hard limits, alerts, or billing controls at the translation provider and restrict administrator access to the generation action.

## Safety Boundaries

- Visitors cannot trigger AI translation.
- Admin must explicitly enable translation before provider calls are allowed.
- Generated translations are saved as machine-source drafts by default.
- Published translations require creator/admin review under the default policy.
- Direct publish is an explicit creator-controlled opt-in policy; it is never enabled automatically by the provider or visitors.
- Provider failure occurs before draft persistence, so a partial provider result is not published as a completed translation.
- The creator remains responsible for provider budget, translation strategy, review, and publication policy.
