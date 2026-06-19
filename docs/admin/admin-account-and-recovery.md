# Administrator account, sessions, and recovery

The administrator account page at `/admin/account` provides:

- email and password changes with current-password confirmation;
- active session visibility, including IP, user agent, creation, and expiry;
- revoking one session or every session except the current one;
- an audit history for administrator account maintenance.

Changing the password keeps the current session active and revokes every other administrator session.
Passwords and password hashes are never written to `audit_events`.

## Recover a locked administrator account

The production image includes `/app/dist/admin-reset.mjs`. Run it from the Compose host:

```bash
docker compose exec \
  -e ADMIN_EMAIL=you@example.com \
  -e ADMIN_PASSWORD='replace-with-a-strong-password' \
  app node dist/admin-reset.mjs
```

The script:

1. validates `DATABASE_URL`, `ADMIN_EMAIL`, and an administrator password of at least 8 characters;
2. creates or updates the specified email as an administrator using bcrypt cost 12;
3. revokes every session for that account;
4. records an `account_recovered` system audit event.

The script never prints the password or password hash. Environment variables may be visible to privileged
host users while the command runs, so execute it only from a trusted host shell and remove it from shell
history when required by your operating policy.

For a source checkout, the equivalent command is:

```bash
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='replace-with-a-strong-password' \
pnpm admin:reset
```
