# Docker Compose Deployment

The default deployment uses the included app and PostgreSQL services.

## Quick Start

```bash
cp .env.example .env
# Edit APP_URL, SESSION_SECRET, SMTP, and storage settings.
docker compose up -d --build
```

The app container entrypoint:

1. prepares uploads and secrets directories,
2. creates or loads the config encryption key,
3. runs database migrations,
4. starts the Next.js server.

If migrations fail, the app does not start.

## Required Production Settings

- `APP_URL`
- `SESSION_SECRET`
- `DATABASE_URL`
- SMTP settings for fan login emails
- `CONFIG_ENCRYPTION_KEY` or `CONFIG_ENCRYPTION_KEY_FILE`
- upload/storage limits appropriate for your server

See `.env.example` for the full list.

## Health Checks

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/ready
```

`/api/ready` checks database connectivity, settings reads, and the config encryption key.

## Volumes to Back Up

- PostgreSQL data volume
- uploads volume when using local storage
- secrets volume containing `/app/secrets/config-encryption-key`

Losing the config encryption key may make encrypted admin settings unrecoverable.
