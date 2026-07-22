# Plausible Analytics

OpenLayerlyPro supports Plausible through the validated
`site_settings.public_integrations` registry. Add a `plausible` record under
**Admin → Site settings → Public page security and integrations** instead of
pasting a script into a footer field.

```json
[
  {
    "id": "plausible-cloud",
    "provider": "plausible",
    "domain": "artist.example"
  }
]
```

The defaults load `https://plausible.io/js/script.manual.js` and send events to the
exact endpoint `https://plausible.io/api/event`. A self-hosted deployment can
set `scriptUrl` to an exact HTTPS URL and `apiOrigin` to an exact HTTPS origin:

```json
[
  {
    "id": "plausible-self-hosted",
    "provider": "plausible",
    "domain": "artist.example",
    "scriptUrl": "https://cdn.example.com/plausible/script.manual.js",
    "apiOrigin": "https://analytics.example.com"
  }
]
```

The server derives `script-src` from `scriptUrl` and `connect-src` from
`apiOrigin`; credentials, HTTP, protocol-relative URLs, wildcards, and bare
schemes fail validation. `scriptUrl` must select a Plausible build whose final
filename ends in `.js` and contains `manual` as a dot-delimited segment (for
example `script.manual.js` or `script.hash.manual.js`). The generic
`script.js` is rejected because it installs automatic initial and History API
tracking. The event target is always the exact validated
`apiOrigin` plus `/api/event`.

Extension builds containing `outbound-links`, `file-downloads`, or
`tagged-events` are rejected even when combined with `manual`. Those extensions
install document-level listeners whose event payloads default to the current
browser URL; after client navigation that could expose a private route URL.

OpenLayerlyPro loads Plausible's automatic-pageview-disabled manual build and
adds a nonce-authorized route tracker. Initial load and `pushState`, `replaceState`,
or `popstate` navigation emit only when the current pathname belongs to the
shared public integration route set. Private routes such as `/me`,
`/checkout/*`, `/admin`, and `/login` are never queued. Pageviews deduplicate
by pathname plus query string.

Set `enabled` to `false` to retain a valid stored configuration while rendering
no script and adding no CSP origins. Validate the deployment in
`SECURITY_CSP_MODE=report-only` or `auto`, including public-to-private SPA
navigation, before enforcing CSP.

Configure at most one enabled Plausible record. Disabled records may be kept for
staged configuration, but multiple enabled records would install multiple
History API hooks and double-count the same public navigation, so validation
rejects that state.
