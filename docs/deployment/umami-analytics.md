# Umami Analytics

OpenLayerlyPro supports Umami through the structured `site_settings.public_integrations` registry. Do not paste raw `<script>` tags into legacy footer fields; use the JSON record below so the server can derive the render plan and exact CSP origins from one validated source.

## Admin Configuration

Open **Admin -> Site settings -> Public page security and integrations** and add an `umami` record to the public integrations JSON.

Umami's embed script uses `defer`, `src`, and `data-website-id`. OpenLayerlyPro renders those attributes from the validated record. When `apiOrigin` is present, it is emitted as Umami's `data-host-url` override and also becomes the CSP `connect-src` origin. When `apiOrigin` is omitted, the adapter defaults the connect origin to the exact HTTPS origin of `scriptUrl`.

## Umami Cloud

Use the website UUID from the Umami dashboard:

```json
[
  {
    "id": "umami-cloud",
    "provider": "umami",
    "websiteId": "11111111-1111-4111-8111-111111111111"
  }
]
```

This defaults to `https://cloud.umami.is/script.js`. The derived CSP adds:

- `script-src https://cloud.umami.is`
- `connect-src https://cloud.umami.is`

If your Umami Cloud account or deployment instructions require a separate collection host, set `apiOrigin` to that exact HTTPS origin so OpenLayerlyPro emits `data-host-url` and adds that same origin to `connect-src`.

## Self-Hosted Same Origin

For a normal self-hosted Umami instance where the script and collection API share one origin:

```json
[
  {
    "id": "umami-self-hosted",
    "provider": "umami",
    "websiteId": "22222222-2222-4222-8222-222222222222",
    "scriptUrl": "https://analytics.example.com/script.js"
  }
]
```

The derived CSP adds:

- `script-src https://analytics.example.com`
- `connect-src https://analytics.example.com`

No `data-host-url` is emitted because the tracker can post back to the script origin.

## Self-Hosted Split Origins

If the script is served from a CDN or asset host and events should be sent to another exact origin:

```json
[
  {
    "id": "umami-split-host",
    "provider": "umami",
    "websiteId": "33333333-3333-4333-8333-333333333333",
    "scriptUrl": "https://cdn.example.com/umami/script.js",
    "apiOrigin": "https://analytics.example.com"
  }
]
```

The render plan emits `data-host-url="https://analytics.example.com"`. The derived CSP adds:

- `script-src https://cdn.example.com`
- `connect-src https://analytics.example.com`

## Validation and Rollout

- `websiteId` must be a UUID.
- `scriptUrl` must be an exact HTTPS URL; credentials, HTTP, protocol-relative URLs, wildcards, and bare schemes are rejected.
- `apiOrigin`, when present, must be an exact HTTPS origin.
- Set `enabled` to `false` to keep the configuration saved while rendering no script and adding no CSP source.
- Validate in `SECURITY_CSP_MODE=report-only` or `auto` before enforcing CSP, then confirm the browser reports no blocked Umami script or event requests.
