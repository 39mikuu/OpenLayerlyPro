# Security Policy

## Supported Versions

OpenLayerlyPro v0.1 is a preview/alpha self-hosted release. Security fixes are expected to land on `main` and in the newest preview release line.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Use GitHub Private Vulnerability Reporting:

- https://github.com/39mikuu/OpenLayerlyPro/security/advisories/new

Include:

- affected version or commit
- deployment shape, such as Docker Compose, reverse proxy, or Cloudflare Tunnel
- reproduction steps
- impact assessment
- relevant logs or screenshots with secrets removed

If private vulnerability reporting is temporarily unavailable, contact the maintainer privately through the contact method listed on the maintainer's GitHub profile. Do not include secrets or private payment screenshots in public discussions.

## Self-Hosting Security Checklist

- Set a strong `SESSION_SECRET` in production. The app refuses to start with the default or short value.
- Back up the config encryption key file or Docker `secrets` volume. Losing it can make encrypted settings unrecoverable.
- Run the app behind HTTPS using Cloudflare Tunnel, Caddy, Nginx, Traefik, or another trusted edge.
- Configure `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXY_HOPS` only for proxy layers you control.
- Do not expose the origin port directly when trusting single-value headers such as `cf-connecting-ip`.
- Configure SMTP before allowing fan login in production.
- Keep upload size limits aligned with available memory. v0.1 reads uploaded files into memory before writing them to storage.
- Keep payment proof files private. They are only accessible to the submitting user and admins through the download API.
- Use S3/R2 for large production downloads when possible.
- Review custom footer code before saving it.

## Custom Footer Code Risk

Custom footer code is an administrator-managed self-hosting escape hatch. It is inserted directly into public pages and may include script or HTML.

Only paste trusted snippets. A bad or hostile script can affect visitors, leak analytics data, break pages, or degrade performance. The setting is not rendered in the admin dashboard, emails, or public API responses, and it must never be populated from fan content or post content.

## Secrets

Do not commit real values for:

- `SESSION_SECRET`
- `CONFIG_ENCRYPTION_KEY`
- SMTP passwords
- S3/R2 access keys
- Turnstile secret keys
- AI translation provider keys
- Cloudflare Tunnel tokens

`.env.example` contains placeholders only.
