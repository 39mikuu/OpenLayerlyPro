# Production Checklist

- [ ] `APP_URL` is the public HTTPS URL.
- [ ] `SESSION_SECRET` is strong and unique.
- [ ] SMTP is configured and tested.
- [ ] Config encryption key or key file is backed up.
- [ ] `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXY_HOPS` match the deployment edge.
- [ ] Origin app port is not publicly exposed when trusting proxy headers.
- [ ] Upload limits fit available memory.
- [ ] Storage driver is selected intentionally: `local` or `s3`.
- [ ] S3/R2 credentials are stored through env or admin encrypted config.
- [ ] Turnstile is configured if bot protection is needed.
- [ ] AI translation provider is disabled unless intentionally configured.
- [ ] Custom footer code is reviewed and trusted.
- [ ] `/api/health` and `/api/ready` return 200.
- [ ] Database, uploads, and secrets backup jobs exist.
