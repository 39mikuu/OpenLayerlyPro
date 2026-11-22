# Security Policy

## Supported Versions

OpenLayerlyPro's current release is **v1.1.0** (released on 2026-07-17; see `docs/releases/v1.1.0-release-notes.md`). Security fixes land on `main`.

Self-hosters running an older commit should reproduce against the latest `main` or upgrade through `docs/deployment/upgrade.md` before assuming a fix can be backported safely.

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

- Docker Compose automatically creates a persistent `SESSION_SECRET` file; advanced deployments may provide an external env value or mounted file.
- Back up the config encryption key file or Docker `secrets` volume. Losing it can make encrypted settings unrecoverable.
- Preserve `SESSION_SECRET` across restarts and restores. Replacing or deleting it invalidates existing sessions and in-flight encrypted login-code tasks. File-backed secrets are archived automatically; external env secrets must be backed up separately.
- Do not run `docker compose down -v` without a verified backup of the `secrets` volume.
- Serve the app over HTTPS behind Cloudflare Tunnel, Caddy, Nginx, Traefik, or another trusted reverse proxy.
- Configure `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXY_HOPS` only for proxy layers you control.
- Do not expose port `3000` directly to the public internet when trusting single-value headers such as `cf-connecting-ip`.
- Run a single app instance; rate limits are currently process-local.
- Configure SMTP before enabling fan login in production, and monitor failed or deferred mail tasks in the admin dashboard.
- Align attachment and payment-proof upload limits with reverse-proxy and storage limits. Content attachments stream to local or S3/R2 storage; images are buffered for size validation and re-encoding.
- Use S3/R2 for large production files when possible, and configure an abort-incomplete-multipart lifecycle rule.
- Keep payment proof files private; they are accessible only to the submitting user and admins through the download API.
- Keep Stripe secret keys and webhook secrets encrypted, use HTTPS for webhook delivery, and rely on signed webhooks rather than browser redirects to grant membership.
- Enable only trusted AI translation providers; visitors cannot trigger paid translation calls.
- Review custom integration code and CSP origins carefully before saving them in admin settings; custom scripts run as trusted administrator code.
- Follow `docs/deployment/upgrade.md` when upgrading instead of running a plain `git pull && docker compose up`.
- Periodically test backups in an isolated environment using `./scripts/restore.sh` (see `docs/deployment/backup-restore.md`).

## Public Integration Code Risk

Custom footer HTML has been separated into sanitized footer markup, structured verification records, and nonce-authorized public integrations. Existing legacy footer values remain available in the admin page for inspection, migration, or removal.

Only add trusted custom integration code. A hostile script can affect visitors, leak analytics data, or break pages. Custom code and allowed HTTPS origins must come only from administrators, never from fan or post content.

Production `script-src` uses per-request nonces and disallows `unsafe-inline`, `unsafe-eval`, wildcard script sources, bare schemes, and administrator-supplied nonce attributes.

## Secrets

Do not commit real values for:

- `SESSION_SECRET`
- `CONFIG_ENCRYPTION_KEY`
- SMTP passwords
- S3/R2 access keys
- Turnstile secret keys
- Stripe secret keys and webhook secrets
- AI translation provider keys
- Cloudflare Tunnel tokens

`.env.example` contains placeholders only.
