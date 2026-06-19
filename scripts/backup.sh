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
  echo "FORMAT_VERSION=1"
  echo "CREATED_AT_UTC=$CREATED_AT_UTC"
  echo "STORAGE_DRIVER=$STORAGE_DRIVER"
  echo "UPLOADS_INCLUDED=$UPLOADS_INCLUDED"
} > "$WORK_DIR/manifest.env"

tar -czf "$ARCHIVE_PATH" -C "$WORK_DIR" .
chmod 600 "$ARCHIVE_PATH"
[ -s "$ARCHIVE_PATH" ] || fail "archive was not created"

echo "Backup created: $ARCHIVE_PATH"
echo "Included: PostgreSQL database, config encryption key"
if [ "$UPLOADS_INCLUDED" = true ]; then
  echo "Included: local uploads"
else
  echo "Uploads: skipped for S3/R2; back up the object-storage bucket separately"
fi
