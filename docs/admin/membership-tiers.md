# Membership Tiers and Benefits

Admin path: `/admin/tiers`

Each tier can select from the stable Core benefits shown in the editor. The
available keys are Early access, Behind the scenes, and Supporter recognition;
custom strings are not accepted. Benefit labels and descriptions are displayed
on public tier cards and, for a current member, on the account page in Chinese,
English, or Japanese.

Creating or saving a tier requires an audit reason. Enter a short operational
explanation for the configuration change; it is stored with the audit event,
not as part of the public tier.

Benefits are tier configuration, not a second authorization system. A member's
benefits are read from the current tier row on every request, so edits take
effect immediately for existing active memberships. Suspended, revoked,
expired, or not-yet-started membership rows provide no benefits. Disabling a
tier still controls selling/display only and does not revoke an existing valid
membership.

Content and file access remain governed by tier level and the post's required
tier. The first benefit bundle is informational and does not independently
unlock posts or downloads. Tier create/update and its whitelisted audit snapshot
commit or roll back together; audit snapshots do not contain raw request bodies,
payment configuration, or unapproved fields.
