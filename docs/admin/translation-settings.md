# Translation Settings

Admin path: `/admin/settings`

AI translation is optional and disabled by default.

## Provider

v0.1 supports an OpenAI-compatible chat completions provider configured through the admin dashboard:

- endpoint
- model
- API key
- optional monthly character limit
- direct publish policy
- machine translation label policy

The API key is stored encrypted and is never returned in admin API responses.

## Safety Boundaries

- Visitors cannot trigger AI translation.
- Admin must explicitly enable translation.
- Generated translations are drafts by default.
- Published translations require creator/admin review.
- AI should not automatically publish or decide translation strategy for the creator.
