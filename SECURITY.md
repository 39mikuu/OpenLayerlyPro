# Security Policy

## Supported Versions

OpenLayerlyPro's current release is **v1.0.0** (the `v1.0.0` tag, published after the #88 real-environment acceptance gate passed on the exact release build). Security fixes land on `main`. The older v0.1/v0.2 preview documentation is historical and is not the current release or security-support gate.

Self-hosters running an older commit should reproduce against the latest `main` or upgrade through the documented migration/remediation flow before assuming a fix can be backported safely.

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

- Docker Compose atomically generates a strong file-backed `SESSION_SECRET`; advanced deployments may provide an external env value or mounted file.
- Back up the config encryption key file or Docker `secrets` volume. Losing it can make encrypted settings unrecoverable.
- Preserve the same `SESSION_SECRET` for session/login-task recovery. Replacing or deleting it intentionally invalidates sessions and can make in-flight encrypted login-code tasks undecryptable. File-backed values are archived; external values remain the operator's responsibility.
- Never run `docker compose down -v` without a tested recovery point for the secrets volume.
- Run the app behind HTTPS using Cloudflare Tunnel, Caddy, Nginx, Traefik, or another trusted edge.
- Configure `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXY_HOPS` only for proxy layers you control.
- Do not expose the origin port directly when trusting single-value headers such as `cf-connecting-ip`.
- Use one app instance unless a shared rate-limit backend has been implemented; the current limiter is process-local.
- Configure SMTP before allowing fan login in production, and monitor failed/dead/deferred mail tasks plus the delivery ledger.
- Keep attachment and payment-proof upload limits aligned with reverse-proxy and storage limits. Content attachments stream to local or S3/R2 storage; image purposes are buffered for bounded validation and mandatory raster normalization.
- Use S3/R2 for large production files when possible, and configure an abort-incomplete-multipart lifecycle rule.
- Keep payment proof files private. They are only accessible to the submitting user and admins through the download API.
- Keep Stripe secret keys and webhook secrets encrypted, use HTTPS for webhook delivery, and never grant membership from browser redirects alone.
- Enable only trusted AI translation providers; visitors cannot trigger paid translation calls.
- Use safe footer markup and structured verification/integration records. Review
  custom integration code and exact CSP origins before saving them; custom
  scripts remain trusted administrator code.
- Follow `docs/deployment/upgrade.md`; do not replace the documented remediation/backfill flow with a plain `git pull && docker compose up`.
- Run periodic isolated restore drills using the S7 archive-integrity, schema-probing, restored-task neutralization, file-safety remediation, and DB↔storage convergence pipeline.

## Public Integration Code Risk

The legacy mixed-purpose custom footer has been replaced by sanitized footer
markup, structured verification records, and nonce-authorized public
integrations. Existing legacy values remain available in the admin page for
explicit copy, download, safe migration, or clearing.

Only add trusted custom integration code. A bad or hostile script can affect
visitors, leak analytics data, break pages, or degrade performance. Custom code
and its precise HTTPS origins must never be populated from fan or post content.

Production `script-src` uses per-request nonces and does not allow
`unsafe-inline`, `unsafe-eval`, wildcard script sources, bare schemes, or
administrator-supplied nonce attributes.

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
