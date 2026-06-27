# Security Policy

## Supported Versions

OpenLayerlyPro is currently on the **pre-release v1.0 line**. Security fixes land on `main`; a production `v1.0.0` release will not be declared until S6 (#86), S7 (#87), and the final acceptance gate (#88) are complete. The older v0.1/v0.2 preview documentation is historical and is not the current release or security-support gate.

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

- Set a strong `SESSION_SECRET` in production. The app refuses to start with the default or short value.
- Back up the config encryption key file or Docker `secrets` volume. Losing it can make encrypted settings unrecoverable.
- Preserve the same `SESSION_SECRET` for seamless session/login-task recovery; rotating it intentionally invalidates sessions and can make in-flight encrypted login-code tasks undecryptable.
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
- Review custom footer code before saving it. Until S6 #86 migrates legacy code to the nonce-CSP model, it remains a trusted administrator escape hatch with public-page script risk.
- Follow `docs/deployment/upgrade.md`; do not replace the documented remediation/backfill flow with a plain `git pull && docker compose up`.
- Run periodic isolated restore drills. The v1.0 release additionally requires S7 #87 archive integrity, schema probing, restored-task neutralization, file-safety remediation, and DB↔storage convergence.

## Custom Footer Code Risk

Custom footer code is an administrator-managed self-hosting escape hatch in the current runtime. It is inserted directly into public pages and may include script or HTML.

Only paste trusted snippets. A bad or hostile script can affect visitors, leak analytics data, break pages, or degrade performance. The setting is not rendered in the admin dashboard, emails, or public API responses, and it must never be populated from fan content or post content.

S6 #86 will replace this mixed-purpose field with safe footer markup, structured site verification, and nonce-authorized public integrations. The implementation must preserve legacy values for migration and must not weaken production CSP with `unsafe-inline`, wildcard script sources, or administrator-supplied nonce attributes.

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
