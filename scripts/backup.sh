#!/bin/sh
# shellcheck disable=SC2016 # Expand Compose service variables inside the container shell.
set -eu

umask 077

usage() {
  echo "Usage: $0 [output-directory]" >&2
}

fail() {
  echo "backup: $*" >&2
  exit 1
}

compose() {
  docker compose "$@"
}

[ "$#" -le 1 ] || {
  usage
  exit 2
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
docker compose version >/dev/null 2>&1 || fail "docker compose is required"

OUTPUT_DIR=${1:-./backups}
mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
CREATED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-backup.XXXXXX")
ARCHIVE_PATH="$OUTPUT_DIR/openlayerly-backup-$TIMESTAMP.tar.gz"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup 0 HUP INT TERM

APP_VERSION=$(node -e 'console.log(require("./package.json").version)' 2>/dev/null || echo "unknown")

echo "Backing up PostgreSQL database..."
compose exec -T postgres sh -c '
  set -eu
  exec pg_dump -U "${POSTGRES_USER:-artist}" "${POSTGRES_DB:-artist_member}"
' > "$WORK_DIR/db.sql"
[ -s "$WORK_DIR/db.sql" ] || fail "database dump is empty"

if ! compose exec -T app sh -c 'test -z "${CONFIG_ENCRYPTION_KEY:-}"'; then
  fail "CONFIG_ENCRYPTION_KEY is set; back up that externally managed value separately and use the file-backed key for single-archive backups"
fi

CONFIG_KEY_FILE=$(compose exec -T app sh -c 'printf %s "${CONFIG_ENCRYPTION_KEY_FILE:-/app/secrets/config-encryption-key}"')
case "$CONFIG_KEY_FILE" in
  /*) ;;
  *) fail "CONFIG_ENCRYPTION_KEY_FILE must be an absolute container path" ;;
esac

echo "Reading migration identity from the live database..."
MIGRATION_IDENTITIES_JSON=$(
  compose exec -T postgres sh -c '
    set -eu
    exec psql -v ON_ERROR_STOP=1 -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" -c "
      select coalesce(
        json_agg(
          json_build_object('"'"'hash'"'"', hash, '"'"'createdAt'"'"', created_at::bigint)
          order by id
        ),
        '"'"'[]'"'"'::json
      )
      from __drizzle_migrations;
    "
  '
) || fail "unable to read migration identity from database"

LATEST_MIGRATION_HASH=$(
  node -e '
    const rows = JSON.parse(process.argv[1]);
    if (!Array.isArray(rows) || rows.length === 0) process.exit(1);
    process.stdout.write(rows[rows.length - 1].hash);
  ' "$MIGRATION_IDENTITIES_JSON"
) || fail "migration history is empty; run migrations before backup"

echo "Backing up config encryption key file..."
mkdir -p "$WORK_DIR/secrets"
compose cp "app:$CONFIG_KEY_FILE" "$WORK_DIR/secrets/config-encryption-key"
[ -s "$WORK_DIR/secrets/config-encryption-key" ] || fail "config encryption key file is missing or empty"
chmod 600 "$WORK_DIR/secrets/config-encryption-key"

STORAGE_DRIVER=$(compose exec -T app sh -c 'printf %s "${STORAGE_DRIVER:-local}"')
case "$STORAGE_DRIVER" in
  local)
    echo "Backing up local uploads..."
    mkdir -p "$WORK_DIR/uploads"
    compose cp app:/app/uploads/. "$WORK_DIR/uploads"
    UPLOADS_INCLUDED=true
    ;;
  s3)
    echo "STORAGE_DRIVER=s3: skipping uploads volume; protect the bucket with provider backups/versioning."
    : > "$WORK_DIR/UPLOADS_SKIPPED_S3"
    UPLOADS_INCLUDED=false
    ;;
  *)
    fail "unsupported STORAGE_DRIVER value: $STORAGE_DRIVER"
    ;;
esac

{
  echo "FORMAT_VERSION=2"
  echo "CREATED_AT_UTC=$CREATED_AT_UTC"
  echo "APP_VERSION=$APP_VERSION"
  echo "STORAGE_DRIVER=$STORAGE_DRIVER"
  echo "UPLOADS_INCLUDED=$UPLOADS_INCLUDED"
  echo "LATEST_MIGRATION_HASH=$LATEST_MIGRATION_HASH"
  echo "MIGRATION_IDENTITIES_JSON=$MIGRATION_IDENTITIES_JSON"
  echo "BACKUP_WINDOW_NOTE=hot-backup order pg_dump(T1) then uploads(T2); expect T1-T2 drift unless app was stopped"
} > "$WORK_DIR/manifest.env"

echo "Generating archive checksums..."
(
  cd "$WORK_DIR" || exit 1
  find . -type f ! -name 'checksums.sha256' -print \
    | LC_ALL=C sort \
    | while IFS= read -r path; do
        rel=${path#./}
        sha256sum "$rel"
      done
) > "$WORK_DIR/checksums.sha256"
[ -s "$WORK_DIR/checksums.sha256" ] || fail "checksum file was not created"

tar -czf "$ARCHIVE_PATH" -C "$WORK_DIR" .
chmod 600 "$ARCHIVE_PATH"
[ -s "$ARCHIVE_PATH" ] || fail "archive was not created"

echo "Backup created: $ARCHIVE_PATH"
echo "Included: PostgreSQL database, config encryption key, manifest v2, checksums"
if [ "$UPLOADS_INCLUDED" = true ]; then
  echo "Included: local uploads"
else
  echo "Uploads: skipped for S3/R2; back up the object-storage bucket separately"
fi
echo "Migration identity: $LATEST_MIGRATION_HASH"
echo "SESSION_SECRET is not included; back it up separately for seamless session recovery"