# Storage Settings

Admin path: `/admin/settings`

OpenLayerlyPro supports:

- local storage
- S3-compatible storage, including Cloudflare R2

## Important Behavior

Each uploaded file records its `storageDriver`. Switching the active storage driver does not migrate existing files. Old files continue to read from the driver recorded at upload time.

## S3/R2 Notes

- Use `S3_REGION=auto` for Cloudflare R2.
- Keep access keys encrypted in admin config or server-side env.
- Use S3/R2 for large production downloads.
- Test connection performs an object round trip rather than relying only on bucket metadata.
