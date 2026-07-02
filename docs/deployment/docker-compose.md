# Docker Compose Deployment

The default deployment uses the included app and PostgreSQL services.

## Quick Start

```bash
cp .env.example .env
# Edit APP_URL, SMTP, and storage settings. SESSION_SECRET may stay unset.
docker compose up -d --build
```

The app container entrypoint:

1. prepares uploads and secrets directories,
2. creates or loads the config encryption key,
3. atomically creates or loads `/app/secrets/session-secret`,
4. runs database migrations,
5. validates the session secret before dispatch starts,
6. starts the Next.js server.

If migrations fail, the app does not start.

## Required Production Settings

- `APP_URL`
- `SESSION_SECRET` or `SESSION_SECRET_FILE` (Compose auto-generates a persistent
  file-backed secret at `/app/secrets/session-secret` when both are unset). `docker-compose.yml`
  no longer pins `SESSION_SECRET_FILE`, so a value set in `.env` is honoured; a custom path
  must be inside the container and have its directory mounted (e.g. the `secrets` volume).
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
- secrets volume containing `/app/secrets/config-encryption-key` and
  `/app/secrets/session-secret`

`SESSION_SECRET` environment overrides are never copied to disk. All replicas must use
the same externally managed value or mounted file; a named volume is local to one Docker
host. Losing/replacing the secret invalidates sessions and authentication intermediates.
`docker compose down -v` deletes the secrets volume and is destructive without a tested
backup.
