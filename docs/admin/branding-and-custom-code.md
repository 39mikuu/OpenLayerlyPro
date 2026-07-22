# Branding and Custom Footer Code

OpenLayerlyPro lets self-hosted administrators customize public-site branding without adding a plugin or changing the built-in theme.

## Brand Assets

Go to **Admin → Site settings → Branding** to upload:

- **Site logo**: used by the public header and footer when configured.
- **Site icon / favicon**: used as the browser/app icon when configured.

Recommended formats:

- Logo: PNG, JPEG, or WebP accepted by the file-safety pipeline; transparent PNG/WebP is recommended.
- Icon: square PNG or WebP, such as 512×512.

Image-purpose uploads are server-detected and raster-normalized. SVG/HTML/non-raster data is not accepted as a branding image. When no logo is configured, the built-in theme falls back to the creator/site initial or creator avatar.

## Safe Public Customization

**Admin → Site settings → Public page security and integrations** separates:

- `custom_footer_markup`: sanitized display-only footer markup;
- `site_verification`: structured verification metadata rendered into `<head>`;
- `public_integrations`: validated Plausible, Umami, or advanced custom records whose
  render plan and exact CSP origins come from one server registry.

Footer markup is sanitized on write and read. Scripts, styles, frames, metadata
tags, event attributes, `javascript:` URLs, inline styles, and administrator
supplied nonce attributes are removed. Integration scripts are rendered by the
server with the current request nonce; raw script tags are never accepted as
footer markup.

Advanced custom integrations are trusted owner code. They allow either one
exact HTTPS script URL or one inline body, constrained data attributes, and
explicit exact HTTPS resource origins. They do not accept raw attributes,
wildcards, bare schemes, credentials in URLs, or a caller-supplied nonce.

Historically this field has been used for three different needs:

- ordinary footer/filing/compliance markup;
- site ownership verification;
- analytics or other executable scripts.

The original `custom_footer_html` value remains a high-trust self-hosting escape
hatch rather than a normal content field. Never populate it from fan input,
post content, comments, imports, or an untrusted third party.

## Legacy Migration

Existing values are classified as `empty`, `safe_markup`, or
`needs_migration`. The admin page preserves the original as read-only text and
provides copy, download, clear, and safe-markup migration actions.

- `SECURITY_CSP_MODE=auto` enforces CSP when no executable legacy value exists
  and otherwise uses Report-Only on all HTML documents while the original
  public behavior remains visible.
- `SECURITY_CSP_MODE=report-only` explicitly keeps all HTML documents in
  browser observation mode.
- `SECURITY_CSP_MODE=enforce` never renders executable legacy content, but the
  original remains available to the administrator until explicitly cleared.

Admin saves carry the public-security revision read with the page. If another
tab changes trusted markup, verification, or integration sources first, the
stale save is rejected before any site setting is written; reload the page,
review the newer trusted-source configuration, and apply the intended change
again.

For executable legacy code, copy/download the original, recreate supported
verification and analytics behavior as structured records, validate it in
Report-Only, then clear the legacy value and switch to enforce (or let `auto`
enforce). See [Plausible Analytics](../deployment/plausible-analytics.md) and
[Umami Analytics](../deployment/umami-analytics.md) for their supported record
shapes, public-only SPA behavior, and CSP derivation. Production CSP never adds
`script-src 'unsafe-inline'`,
`'unsafe-eval'`, wildcard hosts, or a bare `https:` compatibility escape.

The style policy uses the documented `style-src 'self' 'unsafe-inline'`
compatibility fallback because Next.js client navigation applies framework
style attributes that cannot carry a nonce. This exception applies only to
styles; scripts remain nonce-authorized.

The current field is not a Plugin system and must not be used to bypass Core authorization, payment, file, or audit rules.
