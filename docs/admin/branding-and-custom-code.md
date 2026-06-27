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

## Current Legacy Custom Footer

The current runtime still exposes **Admin → Site settings → Custom code** and stores trusted administrator HTML in `customFooterHtml`. It is inserted only on public pages and is not returned by `/api/site`, rendered in admin pages, or used in email.

Historically this field has been used for three different needs:

- ordinary footer/filing/compliance markup;
- site ownership verification;
- analytics or other executable scripts.

Because raw administrator HTML may contain scripts, event attributes, remote resources, or broken markup, it is a high-trust self-hosting escape hatch rather than a normal content field. Never populate it from fan input, post content, comments, imports, or an untrusted third party.

## S6 Migration Status

S6 #86 will replace the mixed-purpose legacy field with separate safe capabilities:

- sanitized/restricted footer markup for ordinary display;
- structured site-verification records rendered by the server;
- structured public integrations whose render plan and exact CSP origins are owned by the application;
- an explicitly high-risk custom integration record only where unavoidable.

The S6 implementation must preserve the original legacy value for review/export and detect executable content before enforcing CSP. It must not silently delete or disable code, and it must not preserve compatibility by adding `script-src 'unsafe-inline'`, wildcard hosts, bare `https:`, or trusting administrator-supplied nonce attributes.

Until #86 is implemented and migrated:

- only paste code you fully trust;
- review analytics/privacy implications and remote hosts;
- keep a copy outside the application before upgrades;
- expect v1.0 rollout to require migration, explicit disablement, or report-only observation before CSP enforcement.

The current field is not a Plugin system and must not be used to bypass Core authorization, payment, file, or audit rules.
