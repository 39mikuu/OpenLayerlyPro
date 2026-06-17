# Backup and Restore

## Back Up

Back up before upgrades and before changing storage or encryption settings.

Required:

- PostgreSQL database
- local `uploads` volume when using `STORAGE_DRIVER=local`
- `/app/secrets/config-encryption-key` or the Docker `secrets` volume

Example database backup:

```bash
docker compose exec postgres pg_dump -U artist artist_member > backup.sql
```

Copy uploads and secrets volumes using your host backup tooling.

## Restore

1. Stop the app.
2. Restore the PostgreSQL database.
3. Restore uploads if using local storage.
4. Restore the config encryption key before starting the app.
5. Start the app and check `/api/ready`.

## Encryption Key Warning

The config encryption key protects admin-managed secrets such as SMTP password, storage keys, Turnstile secret, and AI provider keys. If the key is lost, encrypted settings may not be recoverable.
