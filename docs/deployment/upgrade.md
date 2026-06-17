# Upgrade

## Before Upgrading

- Read `CHANGELOG.md`.
- Back up the database.
- Back up uploads if using local storage.
- Back up `/app/secrets/config-encryption-key` or the Docker `secrets` volume.
- Review `.env.example` for new settings.

## Upgrade Steps

```bash
git pull --ff-only
docker compose build
docker compose up -d
docker compose logs app
```

The app container runs migrations before starting. If migrations fail, the app exits instead of serving traffic.

## Rollback

Rollback requires:

- previous app image or source tag
- database backup from before the upgrade
- matching config encryption key
- uploads backup if local files changed

Restore the backup and redeploy the previous tag.
