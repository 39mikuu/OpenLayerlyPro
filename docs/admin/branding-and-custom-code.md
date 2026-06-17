# Branding and Custom Footer Code

OpenLayerlyPro lets self-hosted administrators customize public-site branding without adding a plugin or changing the default theme code.

## Brand assets

Go to **Admin -> Site settings -> Branding** to upload:

- **Site logo**: used by the public header and footer when configured.
- **Site icon / favicon**: used as the browser/app icon when configured.

Recommended formats:

- Logo: transparent PNG or WebP. Square and horizontal images are both supported.
- Icon: 512x512 PNG or WebP.

When no logo is configured, the public theme falls back to the creator/site initial or the creator avatar. The open-source default theme does not include third-party brand marks, payment logos, social-platform logos, or trademark-like geometric marks as the default identity.

## Custom footer code

Go to **Admin -> Site settings -> Custom code** to paste optional footer HTML. Typical uses include:

- analytics snippets
- ICP/filing or compliance text
- site verification tags
- small self-hosting HTML snippets

The code is inserted only on public pages. It is not rendered in the admin dashboard, emails, or API responses.

## Security notes

Custom footer code is an administrator-managed trusted customization. It is inserted directly into public pages, so only paste code from sources you trust.

Avoid unknown snippets. Broken or hostile scripts can affect visitor pages, page performance, and privacy. This setting is not a plugin system, and it should not be used with content submitted by fans, posts, comments, or any other user-generated input.
