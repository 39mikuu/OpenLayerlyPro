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

## Public Security and Integrations

The site settings page manages display-only sanitized footer markup, structured
site verification, and structured nonce-authorized public integrations.

Legacy `custom_footer_html` remains read-only and is classified for migration.
The original can be copied or downloaded and is not silently deleted. Complete
the migration and browser observation before enforcing CSP. See
[Branding and Custom Footer Code](./branding-and-custom-code.md). Use
[Umami Analytics](../deployment/umami-analytics.md) for Umami-specific examples.

## Theme Configuration

The active theme (`builtin`, `blog`, or `wordpress`, selectable from the appearance card) reads public identity plus its own `theme_config` color settings. Theme configuration is presentation-only and cannot change membership, payment, content visibility, file authorization, or integration secrets.

## WordPress 经典主题

The `wordpress` theme is a built-in classic blog theme with a main content column and right sidebar. It offers two fixed color presets, `gofun-seiji` and `layer-seal`; admins can select the preset from the appearance card, but the API does not expose or accept raw CSS variables.
