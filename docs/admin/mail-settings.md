# Mail Settings

Admin path: `/admin/settings`

SMTP is required for production fan email-code login and transactional emails.

## Used For

- login verification codes
- membership activation notifications
- payment rejection notifications
- SMTP test emails

## Security

- SMTP passwords are stored through encrypted admin config when configured in the dashboard.
- Do not commit SMTP credentials to `.env`.
- Development mode can log verification codes only when SMTP is not configured. Production does not use this fallback.
