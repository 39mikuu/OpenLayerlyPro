# Site Settings

Admin path: `/admin/site`

Use site settings to configure the public identity and public-site customization.

## Public Identity

- site name;
- creator name and bio;
- creator avatar;
- social links;
- site logo;
- site icon / favicon.

The public API exposes only public site information. Secret integration configuration and legacy custom footer code are not returned by `/api/site`.

## Custom Footer Code

The current runtime manages the legacy trusted `customFooterHtml` field on the site settings page and inserts it only on public pages. It can contain executable administrator code, so it must never be populated from user-generated content or an untrusted import.

S6 #86 will migrate this mixed-purpose capability into safe footer markup, structured site verification, and nonce-authorized public integrations. Before production CSP enforcement, existing executable footer values must be detected, preserved for review/export, and either migrated or explicitly disabled. See [Branding and Custom Footer Code](./branding-and-custom-code.md).

## Theme Configuration

The active built-in theme reads public identity plus `theme_config` color settings. Theme configuration is presentation-only and cannot change membership, payment, content visibility, file authorization, or integration secrets.
