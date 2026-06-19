#!/bin/sh
# shellcheck disable=SC2016 # Expand Compose service variables inside the container shell.
set -eu

umask 077

usage() {
  echo "Usage: $0 <archive.tar.gz> [--yes]" >&2
}

fail() {
  echo "restore: $*" >&2
  exit 1
}

compose() {
  docker compose "$@"
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || {
  usage
  exit 2
}

ARCHIVE_PATH=$1
ASSUME_YES=false
if [ "$#" -eq 2 ]; then
  [ "$2" = "--yes" ] || {
    usage
    exit 2
  }
  ASSUME_YES=true
fi

[ -f "$ARCHIVE_PATH" ] || fail "archive not found: $ARCHIVE_PATH"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
docker compose version >/dev/null 2>&1 || fail "docker compose is required"

if tar -tzf "$ARCHIVE_PATH" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null 2>&1; then
  fail "archive contains an unsafe path"
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-restore.XXXXXX")
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup 0 HUP INT TERM

tar -xzf "$ARCHIVE_PATH" -C "$WORK_DIR"
[ -s "$WORK_DIR/db.sql" ] || fail "archive is missing db.sql"
[ -s "$WORK_DIR/secrets/config-encryption-key" ] || fail "archive is missing the config encryption key"

if [ "$ASSUME_YES" != true ]; then
  [ -t 0 ] || fail "confirmation requires an interactive terminal; pass --yes for automation"
  echo "This will replace the target Compose project's database and file-backed secrets."
  echo "Local uploads will also be replaced when they are present in the archive."
  printf "Type RESTORE to continue: "
  read -r answer
  [ "$answer" = "RESTORE" ] || fail "restore cancelled"
fi

echo "Starting PostgreSQL for the target Compose project..."
compose up -d postgres

attempt=0
until compose exec -T postgres sh -c '
  exec pg_isready -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" >/dev/null
'; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || fail "PostgreSQL did not become ready"
  sleep 2
done

compose stop app >/dev/null 2>&1 || true
compose create app >/dev/null

if ! compose run --rm -T --no-deps --entrypoint sh app -c 'test -z "${CONFIG_ENCRYPTION_KEY:-}"'; then
  fail "target defines CONFIG_ENCRYPTION_KEY; unset it or restore the matching externally managed value before continuing"
fi

echo "Replacing PostgreSQL database..."
compose exec -T postgres sh -c '
  set -eu
  db_user=${POSTGRES_USER:-artist}
  db_name=${POSTGRES_DB:-artist_member}
  dropdb --if-exists --force -U "$db_user" "$db_name"
  createdb -U "$db_user" "$db_name"
'
compose exec -T postgres sh -c '
  set -eu
  exec psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}"
' < "$WORK_DIR/db.sql"

echo "Restoring config encryption key file..."
compose cp "$WORK_DIR/secrets/config-encryption-key" app:/app/secrets/config-encryption-key

if [ -d "$WORK_DIR/uploads" ]; then
  echo "Replacing local uploads..."
  compose run --rm -T --no-deps --entrypoint sh app -c '
    set -eu
    upload_dir=${UPLOAD_DIR:-/app/uploads}
    mkdir -p "$upload_dir"
    rm -rf "$upload_dir"/* "$upload_dir"/.[!.]* "$upload_dir"/..?*
  '
  compose cp "$WORK_DIR/uploads/." app:/app/uploads
elif [ -f "$WORK_DIR/UPLOADS_SKIPPED_S3" ]; then
  echo "Archive was created for S3/R2; local uploads were not included."
else
  fail "archive contains neither uploads nor the S3 skip marker"
fi

echo "Starting application and applying forward migrations..."
compose up -d app

READY_URL=${READY_URL:-http://localhost:3000/api/ready}
attempt=0
while :; do
  if READY_RESPONSE=$(curl -fsS "$READY_URL" 2>/dev/null); then
    echo "Ready check passed: $READY_RESPONSE"
    break
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || fail "application did not become ready at $READY_URL"
  sleep 2
done

echo "Restore completed from: $ARCHIVE_PATH"
