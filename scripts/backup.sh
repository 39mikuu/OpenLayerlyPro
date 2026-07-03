#!/bin/sh
# shellcheck disable=SC2016 # Expand Compose service variables inside the container shell.
set -eu

umask 077

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/restore-common.sh disable=SC1091
. "$ROOT_DIR/scripts/restore-common.sh"
# shellcheck source=scripts/backup-app-state.sh disable=SC1091
. "$ROOT_DIR/scripts/backup-app-state.sh"

usage() {
  echo "Usage: $0 [--stop-app] [output-directory]" >&2
}

fail() {
  echo "backup: $*" >&2
  exit 1
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sudo -n env \
      ${COMPOSE_ENV_FILE:+COMPOSE_ENV_FILE=$COMPOSE_ENV_FILE} \
      ${S7_E2E_APP_PORT:+S7_E2E_APP_PORT=$S7_E2E_APP_PORT} \
      ${S7_S3_MINIO_PORT:+S7_S3_MINIO_PORT=$S7_S3_MINIO_PORT} \
      docker "$@"
  fi
}

fix_workspace_permissions() {
  if ! chmod -R u+rwX "$WORK_DIR" 2>/dev/null; then
    sudo -n chown -R "$(id -u)":"$(id -g)" "$WORK_DIR" \
      || fail "unable to fix backup workspace permissions"
    chmod -R u+rwX "$WORK_DIR" || fail "unable to secure backup workspace permissions"
  fi
}

compose() {
  project_args=""
  env_args=""
  file_args=""
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    project_args="-p $COMPOSE_PROJECT_NAME"
  fi
  if [ -n "${COMPOSE_ENV_FILE:-}" ]; then
    env_args="--env-file $COMPOSE_ENV_FILE"
  fi
  if [ -n "${COMPOSE_FILE:-}" ]; then
    OLDIFS=$IFS
    IFS=:
    for file in $COMPOSE_FILE; do
      file_args="$file_args -f $file"
    done
    IFS=$OLDIFS
  fi
  # shellcheck disable=SC2086
  docker_cmd compose $project_args $env_args $file_args "$@"
}

STOP_APP=false
OUTPUT_DIR=""
for arg in "$@"; do
  case "$arg" in
    --stop-app)
      STOP_APP=true
      ;;
    --*)
      usage
      exit 2
      ;;
    *)
      if [ -n "$OUTPUT_DIR" ]; then
        usage
        exit 2
      fi
      OUTPUT_DIR=$arg
      ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v node >/dev/null 2>&1 || fail "node is required"
compose version >/dev/null 2>&1 || fail "docker compose is required"

OUTPUT_DIR=${OUTPUT_DIR:-./backups}
mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
CREATED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-backup.XXXXXX")
ARCHIVE_PATH="$OUTPUT_DIR/openlayerly-backup-$TIMESTAMP.tar.gz"
ARCHIVE_TMP=$(mktemp "$OUTPUT_DIR/.openlayerly-backup-$TIMESTAMP.XXXXXX")
APP_RESTART_NEEDED=false
APP_WAS_ACTIVE=false
# shellcheck disable=SC2034 # Read by sourced backup-app-state.sh.
APP_CONTAINER_IDS_TO_RESTART=""

cleanup() {
  cleanup_status=$?
  rm -rf "$WORK_DIR" || true
  rm -f "$ARCHIVE_TMP" || true

  if [ "$APP_RESTART_NEEDED" = true ]; then
    echo "backup: restoring app service after interrupted/failed backup..." >&2
    if ! restart_app_if_needed; then
      echo "backup: failed to restart app service during cleanup" >&2
      [ "$cleanup_status" -ne 0 ] || cleanup_status=1
    fi
  fi

  trap - EXIT
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

APP_VERSION=$(node -e 'console.log(require("./package.json").version)' 2>/dev/null || echo "unknown")

# Resolve all app environment and volume paths through one-off containers. This keeps
# backup operable when the normal app/dispatcher is already stopped and avoids requiring
# compose exec during the strong-consistency window.
if ! compose run --rm -T --no-deps --entrypoint sh app -c 'test -z "${CONFIG_ENCRYPTION_KEY:-}"'; then
  fail "CONFIG_ENCRYPTION_KEY is set; back up that externally managed value separately and use the file-backed key for single-archive backups"
fi

CONFIG_KEY_FILE=$(read_container_config_key_file)
validate_config_key_file_path "$CONFIG_KEY_FILE"

if compose run --rm -T --no-deps --entrypoint sh app -c 'test -n "${SESSION_SECRET:-}"'; then
  SESSION_SECRET_SOURCE="external"
  SESSION_SECRET_FILE=""
  SESSION_SECRET_SHA256=$(
    compose run --rm -T --no-deps --entrypoint node app -e '
      const { createHash } = require("crypto");
      const value = process.env.SESSION_SECRET;
      if (!value || value.trim().length === 0 || value === "change-me" || value.length < 32) {
        process.exit(1);
      }
      process.stdout.write(createHash("sha256").update(value).digest("hex"));
    '
  ) || fail "externally managed SESSION_SECRET is missing or invalid"
else
  SESSION_SECRET_SOURCE="file"
  SESSION_SECRET_FILE=$(read_container_session_secret_file)
  validate_session_secret_file_path "$SESSION_SECRET_FILE"
  SESSION_SECRET_SHA256=""
fi

STORAGE_DRIVER=$(compose run --rm -T --no-deps --entrypoint sh app -c \
  'printf %s "${STORAGE_DRIVER:-local}"' | tr -d '\r')
case "$STORAGE_DRIVER" in
  local)
    UPLOAD_DIR=$(read_container_upload_dir)
    validate_upload_dir_path "$UPLOAD_DIR"
    UPLOADS_INCLUDED=true
    ;;
  s3)
    UPLOAD_DIR=""
    UPLOADS_INCLUDED=false
    ;;
  *)
    fail "unsupported STORAGE_DRIVER value: $STORAGE_DRIVER"
    ;;
esac

# compose cp targets the service container, which may be stopped or absent. Ensure it
# exists before entering the optional stop window.
compose create app >/dev/null

if [ "$STOP_APP" = true ]; then
  backup_stop_app_for_consistent_backup
fi

if [ "$STORAGE_DRIVER" = local ]; then
  compose run --rm -T --no-deps \
    -v "$ROOT_DIR/scripts/validate-backup-tree.mjs:/backup-tools/validate-backup-tree.mjs:ro" \
    --entrypoint node app \
    /backup-tools/validate-backup-tree.mjs "$UPLOAD_DIR" "live upload tree" \
    || fail "live upload tree contains unsupported entries"
fi

echo "Backing up PostgreSQL database..."
compose exec -T postgres sh -c '
  set -eu
  exec pg_dump -U "${POSTGRES_USER:-artist}" "${POSTGRES_DB:-artist_member}"
' > "$WORK_DIR/db.sql"
[ -s "$WORK_DIR/db.sql" ] || fail "database dump is empty"

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
      from drizzle.__drizzle_migrations;
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
fix_workspace_permissions
chmod 600 "$WORK_DIR/secrets/config-encryption-key" || fail "unable to secure config encryption key in backup workspace"

if [ "$SESSION_SECRET_SOURCE" = file ]; then
  echo "Backing up session secret file..."
  compose run --rm -T --no-deps --entrypoint sh app -c '
    set -eu
    test -f "$1"
    test ! -L "$1"
    [ "$(stat -c %a "$1")" = "600" ]
    node -e "
      const fs = require(\"fs\");
      const value = fs.readFileSync(process.argv[1], \"utf8\").replace(/\\r?\\n$/, \"\");
      if (!value || value.trim().length === 0 || value === \"change-me\" || value.length < 32) {
        process.exit(1);
      }
    " "$1"
  ' backup-session-secret "$SESSION_SECRET_FILE" \
    || fail "session secret file is invalid or has unsafe permissions"
  compose cp "app:$SESSION_SECRET_FILE" "$WORK_DIR/secrets/session-secret"
  [ -s "$WORK_DIR/secrets/session-secret" ] || fail "session secret file is missing or empty"
  fix_workspace_permissions
  chmod 600 "$WORK_DIR/secrets/session-secret" || fail "unable to secure session secret in backup workspace"
else
  echo "SESSION_SECRET is externally managed; recording fingerprint only."
fi

case "$STORAGE_DRIVER" in
  local)
    echo "Backing up local uploads from $UPLOAD_DIR..."
    mkdir -p "$WORK_DIR/uploads"
    compose cp "app:$UPLOAD_DIR/." "$WORK_DIR/uploads"
    fix_workspace_permissions
    ;;
  s3)
    echo "STORAGE_DRIVER=s3: skipping uploads volume; protect the bucket with provider backups/versioning."
    : > "$WORK_DIR/UPLOADS_SKIPPED_S3"
    ;;
esac

if [ "$STOP_APP" = true ]; then
  BACKUP_WINDOW_NOTE="consistent backup: normal app stopped before pg_dump and remained stopped through key/upload capture"
else
  BACKUP_WINDOW_NOTE="hot-backup order pg_dump(T1) then uploads(T2); expect T1-T2 drift; use --stop-app for a self-consistent local snapshot"
fi

{
  echo "FORMAT_VERSION=2"
  echo "CREATED_AT_UTC=$CREATED_AT_UTC"
  echo "APP_VERSION=$APP_VERSION"
  echo "STORAGE_DRIVER=$STORAGE_DRIVER"
  echo "UPLOADS_INCLUDED=$UPLOADS_INCLUDED"
  echo "LATEST_MIGRATION_HASH=$LATEST_MIGRATION_HASH"
  echo "MIGRATION_IDENTITIES_JSON=$MIGRATION_IDENTITIES_JSON"
  echo "CONFIG_ENCRYPTION_KEY_FILE=$CONFIG_KEY_FILE"
  echo "SESSION_SECRET_SOURCE=$SESSION_SECRET_SOURCE"
  if [ "$SESSION_SECRET_SOURCE" = file ]; then
    echo "SESSION_SECRET_FILE=$SESSION_SECRET_FILE"
    echo "SESSION_SECRET_ARCHIVE_PATH=secrets/session-secret"
  else
    echo "SESSION_SECRET_SHA256=$SESSION_SECRET_SHA256"
  fi
  echo "BACKUP_WINDOW_NOTE=$BACKUP_WINDOW_NOTE"
} > "$WORK_DIR/manifest.env"

# The snapshot is now fully copied into the private workspace. End the maintenance
# window before checksum/tar work; cleanup still retries restart if this explicit restart
# fails.
restart_app_if_needed || fail "unable to restart app service after consistent backup capture"

node "$ROOT_DIR/scripts/validate-backup-tree.mjs" "$WORK_DIR" "assembled backup workspace" \
  || fail "assembled backup workspace contains unsupported entries"
reject_unsafe_payload_tree "$WORK_DIR"

echo "Generating archive checksums..."
(
  cd "$WORK_DIR" || exit 1
  find . -type f ! -path './checksums.sha256' -print \
    | LC_ALL=C sort \
    | while IFS= read -r path; do
        rel=${path#./}
        sha256sum "$rel"
      done
) > "$WORK_DIR/checksums.sha256"
[ -s "$WORK_DIR/checksums.sha256" ] || fail "checksum file was not created"

tar -czf "$ARCHIVE_TMP" -C "$WORK_DIR" .
chmod 600 "$ARCHIVE_TMP"
[ -s "$ARCHIVE_TMP" ] || fail "archive was not created"
mv -f "$ARCHIVE_TMP" "$ARCHIVE_PATH"

echo "Backup created: $ARCHIVE_PATH"
echo "Included: PostgreSQL database, config encryption key, manifest v2, checksums"
if [ "$UPLOADS_INCLUDED" = true ]; then
  echo "Included: local uploads"
else
  echo "Uploads: skipped for S3/R2; back up the object-storage bucket separately"
fi
if [ "$STOP_APP" = true ]; then
  if [ "$APP_WAS_ACTIVE" = true ]; then
    echo "Consistency mode: app stopped during database/key/upload capture and restarted afterward"
  else
    echo "Consistency mode: app was already stopped and remained stopped during/after capture"
  fi
else
  echo "Consistency mode: hot backup; use --stop-app to block application writes during capture"
fi
echo "Migration identity: $LATEST_MIGRATION_HASH"
if [ "$SESSION_SECRET_SOURCE" = file ]; then
  echo "Included: file-backed session secret"
else
  echo "SESSION_SECRET is externally managed and is not included; preserve the matching value separately"
fi
