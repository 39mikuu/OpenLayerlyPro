# Translation Settings

Admin path: `/admin/settings`

AI translation is optional and disabled by default.

## Provider

The current version supports an OpenAI-compatible chat completions provider configured through the admin dashboard:

- endpoint
- model
- API key
- optional monthly character limit
- direct publish policy
- machine translation label policy

The API key is stored encrypted and is never returned in admin API responses.

## Safety Boundaries

- Visitors cannot trigger AI translation.
- Admin must explicitly enable translation before provider calls are allowed.
- Generated translations are saved as machine-source drafts by default.
- Published translations require creator/admin review under the default policy.
- Direct publish is an explicit creator-controlled opt-in policy; it is never enabled automatically by the provider or by visitors.
- The creator remains responsible for translation strategy, review, and publication policy.
