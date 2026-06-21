# Production Checklist

- [ ] `APP_URL` is the public HTTPS URL.
- [ ] `SESSION_SECRET` is strong and unique.
- [ ] SMTP is configured and tested.
- [ ] Config encryption key or key file is backed up.
- [ ] `TRUSTED_PROXY_HEADER` and `TRUSTED_PROXY_HOPS` match the deployment edge.
- [ ] File requests resolve distinct trusted client IPs in production; otherwise the shared unresolved-client emergency buckets and rate-limited warning remain active.
- [ ] Origin app port is not publicly exposed when trusting proxy headers.
- [ ] Upload limits fit available memory.
- [ ] Storage driver is selected intentionally: `local` or `s3`.
- [ ] S3/R2 credentials are stored through env or admin encrypted config.
- [ ] Reverse proxy forwards video `Range` requests and preserves `206`/`416`, `Content-Range`, and `Accept-Ranges` responses.
- [ ] Inline-video signed URL TTL, normal per-IP limits, and unresolved-client emergency limits have been reviewed for this deployment.
- [ ] Operators understand that only public S3 playback redirects; login/member S3 video remains application-proxied. See [Inline video playback](../admin/inline-video-playback.md).
- [ ] Turnstile is configured if bot protection is needed.
- [ ] AI translation provider is disabled unless intentionally configured.
- [ ] Custom footer code is reviewed and trusted.
- [ ] `/api/health` and `/api/ready` return 200.
- [ ] `scripts/backup.sh` runs on a schedule and copies archives off-host.
- [ ] Backups include PostgreSQL, the config encryption key, and local uploads when used.
- [ ] S3/R2 bucket versioning or provider backups are enabled when object storage is used.
- [ ] A recent archive has been restored successfully in an isolated Compose project.
- [ ] The restore drill verified `/api/ready`, sample data, uploads, and encrypted settings.

## Backup Schedule Example

Run from the repository directory so Compose can find `.env` and `docker-compose.yml`:

```cron
15 3 * * * cd /opt/openlayerlypro && ./scripts/backup.sh /srv/backups/openlayerly >> /var/log/openlayerly-backup.log 2>&1
```

Cron only creates archives. Add a separate retention policy and off-host copy, monitor non-zero exits, and run periodic restore drills using [Backup and Restore](backup-restore.md).
