#!/bin/sh
# shellcheck disable=SC2016 # Expand Compose service variables inside the container shell.
set -eu

umask 077

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/restore-common.sh disable=SC1091
. "$ROOT_DIR/scripts/restore-common.sh"

usage() {
  echo "Usage: $0 <archive.tar.gz> [--yes] [--allow-legacy-v1-unknown-schema]" >&2
}

fail() {
  echo "restore: $*" >&2
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

run_one_off() {
  compose run --rm --no-deps -T \
    -v "$WORK_DIR:/restore-work:ro" \
    --entrypoint node app "$@"
}

run_schema_check() {
  if [ "$ALLOW_LEGACY_V1_UNKNOWN" = true ]; then
    run_one_off /app/dist/restore-schema-check.mjs "$@" --allow-legacy-v1-unknown-schema
  else
    run_one_off /app/dist/restore-schema-check.mjs "$@"
  fi
}

ARCHIVE_PATH=""
ASSUME_YES=false
ALLOW_LEGACY_V1_UNKNOWN=false

for arg in "$@"; do
  case "$arg" in
    --yes)
      ASSUME_YES=true
      ;;
    --allow-legacy-v1-unknown-schema)
      ALLOW_LEGACY_V1_UNKNOWN=true
      ;;
    --*)
      usage
      exit 2
      ;;
    *)
      if [ -n "$ARCHIVE_PATH" ]; then
        usage
        exit 2
      fi
      ARCHIVE_PATH=$arg
      ;;
  esac
done

[ -n "$ARCHIVE_PATH" ] || {
  usage
  exit 2
}

[ -f "$ARCHIVE_PATH" ] || fail "archive not found: $ARCHIVE_PATH"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
compose version >/dev/null 2>&1 || fail "docker compose is required"

if tar -tzf "$ARCHIVE_PATH" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null 2>&1; then
  fail "archive contains an unsafe path"
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-restore.XXXXXX")
PROBE_DB=""
cleanup_workdir() {
  if [ -n "$PROBE_DB" ]; then
    run_postgres_shell '
      set -eu
      dropdb --if-exists --force -U "${POSTGRES_USER:-artist}" "$1" >/dev/null 2>&1 || true
    ' "$PROBE_DB" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
on_signal() {
  cleanup_workdir
  exit "${RESTORE_SIGNAL_EXIT_CODE:-1}"
}
trap cleanup_workdir EXIT
trap 'RESTORE_SIGNAL_EXIT_CODE=130; on_signal' INT
trap 'RESTORE_SIGNAL_EXIT_CODE=143; on_signal' TERM
trap 'RESTORE_SIGNAL_EXIT_CODE=1; on_signal' HUP

tar -xzf "$ARCHIVE_PATH" -C "$WORK_DIR"
reject_unsafe_payload_tree "$WORK_DIR"
[ -s "$WORK_DIR/db.sql" ] || fail "archive is missing db.sql"
[ -s "$WORK_DIR/secrets/config-encryption-key" ] || fail "archive is missing the config encryption key"
[ -f "$WORK_DIR/manifest.env" ] || fail "archive is missing manifest.env"

FORMAT_VERSION=$(grep '^FORMAT_VERSION=' "$WORK_DIR/manifest.env" | cut -d= -f2- | tr -d '\r')
FORMAT_VERSION=${FORMAT_VERSION:-1}
case "$FORMAT_VERSION" in
  1|2) ;;
  *) fail "unsupported FORMAT_VERSION=$FORMAT_VERSION" ;;
esac

if [ "$FORMAT_VERSION" = "2" ]; then
  [ -f "$WORK_DIR/checksums.sha256" ] || fail "FORMAT_VERSION=2 archive is missing checksums.sha256"
  echo "Verifying archive checksums..."
  (
    cd "$WORK_DIR" || exit 1
    sha256sum -c checksums.sha256
  ) || fail "archive checksum verification failed"
  echo "Verifying checksum manifest matches archive payload file set..."
  PAYLOAD_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-restore-payload.XXXXXX")
  CHECKSUM_FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/openlayerly-restore-checksum.XXXXXX")
  (
    cd "$WORK_DIR" || exit 1
    find . -type f ! -path './checksums.sha256' -print \
      | LC_ALL=C sort \
      | sed 's|^\./||' \
      > "$PAYLOAD_FILE_LIST"
    CHECKSUM_FILE_LIST_UNSORTED="${CHECKSUM_FILE_LIST}.unsorted"
    if ! awk '
      substr($0, 1, 1) == "\\" {
        print "restore: escaped checksum paths are unsupported" > "/dev/stderr"
        exit 1
      }
      length($0) < 67 || substr($0, 65, 1) != " " ||
        (substr($0, 66, 1) != " " && substr($0, 66, 1) != "*") {
        print "restore: malformed checksum manifest line" > "/dev/stderr"
        exit 1
      }
      {
        print substr($0, 67)
      }
    ' checksums.sha256 > "$CHECKSUM_FILE_LIST_UNSORTED"; then
      rm -f "$CHECKSUM_FILE_LIST_UNSORTED"
      exit 1
    fi
    LC_ALL=C sort "$CHECKSUM_FILE_LIST_UNSORTED" > "$CHECKSUM_FILE_LIST"
    rm -f "$CHECKSUM_FILE_LIST_UNSORTED"
    if ! awk '
      index($0, "\\") || $0 ~ /[[:cntrl:]]/ {
        exit 1
      }
    ' "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST"; then
      echo "restore: checksum paths contain unsupported backslash/control characters" >&2
      exit 1
    fi
    if ! diff -q "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST" >/dev/null; then
      echo "restore: checksum manifest does not match archive payload file set" >&2
      comm -23 "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST" | sed 's/^/  missing from manifest: /' >&2
      comm -13 "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST" | sed 's/^/  extra in manifest: /' >&2
      exit 1
    fi
  ) || fail "archive checksum manifest bijection check failed"
  rm -f "$PAYLOAD_FILE_LIST" "$CHECKSUM_FILE_LIST"
else
  echo "WARNING: FORMAT_VERSION=1 archive has no checksum protection" >&2
fi

validate_archive_storage_contract "$WORK_DIR" "$FORMAT_VERSION"

if [ "$ASSUME_YES" != true ]; then
  [ -t 0 ] || fail "confirmation requires an interactive terminal; pass --yes for automation"
  echo "This will replace the target Compose project's database and file-backed secrets."
  echo "Local uploads will also be replaced when they are present in the archive."
  echo "The hardened restore pipeline will run migrator, pre-scan, file-safety backfill,"
  echo "task neutralization, and DB/storage convergence before starting the app."
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

APP_CONTAINER_IDS=$(compose ps -aq app)
if [ -n "$APP_CONTAINER_IDS" ]; then
  compose stop app >/dev/null || fail "unable to stop app service; refusing to continue restore"
fi
if [ -n "$(compose ps -q --status running app)" ]; then
  fail "app service is still running after stop; refusing to continue restore"
fi
compose create app >/dev/null

if ! compose run --rm -T --no-deps --entrypoint sh app -c 'test -z "${CONFIG_ENCRYPTION_KEY:-}"'; then
  fail "target defines CONFIG_ENCRYPTION_KEY; unset it or restore the matching externally managed value before continuing"
fi

if [ "$FORMAT_VERSION" = "1" ]; then
  PROBE_DB="openlayerly_restore_probe_$(probe_db_suffix)"
  echo "Probing legacy archive schema compatibility in isolated database $PROBE_DB..."
  # Resolve probe connection credentials from the PostgreSQL container itself rather
  # than host-shell defaults, so deployments using custom POSTGRES_USER/PASSWORD
  # (e.g. via COMPOSE_ENV_FILE or service environment) still connect for the check.
  PROBE_PG_USER=$(compose exec -T postgres sh -c 'printf %s "${POSTGRES_USER:-artist}"' | tr -d '\r')
  PROBE_PG_PASSWORD=$(compose exec -T postgres sh -c 'printf %s "${POSTGRES_PASSWORD:-artist_password}"' | tr -d '\r')
  run_postgres_shell '
    set -eu
    createdb -U "${POSTGRES_USER:-artist}" "$1"
  ' "$PROBE_DB"
  run_postgres_shell '
    set -eu
    exec psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-artist}" -d "$1"
  ' "$PROBE_DB" < "$WORK_DIR/db.sql"

  PROBE_DATABASE_URL="postgresql://$(urlencode "$PROBE_PG_USER"):$(urlencode "$PROBE_PG_PASSWORD")@postgres:5432/$PROBE_DB"
  if ! run_schema_check --database-url="$PROBE_DATABASE_URL" --format-version="$FORMAT_VERSION"; then
    fail "legacy archive schema compatibility check failed"
  fi
  run_postgres_shell '
    set -eu
    dropdb --if-exists --force -U "${POSTGRES_USER:-artist}" "$1"
  ' "$PROBE_DB"
  PROBE_DB=""
else
  echo "Checking archive migration compatibility from manifest..."
  if ! run_schema_check --manifest-path=/restore-work/manifest.env --format-version="$FORMAT_VERSION"; then
    fail "archive schema compatibility check failed"
  fi
fi

# E2E drift injection (RESTORE_E2E_INJECT_MISSING) deliberately deletes restored
# objects and must never run in production. Require the E2E-only image marker and fail
# closed *before* any destructive step if it is requested on a non-E2E image, so an
# inherited environment variable can never turn a production restore into data loss.
if [ "${RESTORE_E2E_INJECT_MISSING:-}" = "1" ]; then
  if ! compose run --rm -T --no-deps --entrypoint sh app -c 'test -f /app/.e2e-tools'; then
    fail "RESTORE_E2E_INJECT_MISSING is set but this is not an E2E image (missing /app/.e2e-tools); refusing destructive drift injection"
  fi
fi

echo "Preflighting config encryption key restore target before database replacement..."
TARGET_CONFIG_KEY_FILE=$(read_container_config_key_file)
preflight_config_key_restore_target "$TARGET_CONFIG_KEY_FILE"

# Resolve and fully preflight UPLOAD_DIR *before* the destructive dropdb, so an
# invalid/out-of-mount/read-only upload target aborts the restore while the
# database is still intact (instead of after it has been replaced).
RESTORE_HAS_UPLOADS=false
TARGET_UPLOAD_DIR=""
if [ -d "$WORK_DIR/uploads" ]; then
  RESTORE_HAS_UPLOADS=true
  echo "Preflighting local uploads restore target before database replacement..."
  TARGET_UPLOAD_DIR=$(read_container_upload_dir)
  preflight_upload_dir_restore_target "$TARGET_UPLOAD_DIR"
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

echo "Restoring config encryption key file to $TARGET_CONFIG_KEY_FILE..."
compose cp "$WORK_DIR/secrets/config-encryption-key" "app:$TARGET_CONFIG_KEY_FILE"
verify_container_nonempty_file "$TARGET_CONFIG_KEY_FILE"

if [ "$RESTORE_HAS_UPLOADS" = true ]; then
  UPLOAD_DIR=$TARGET_UPLOAD_DIR
  echo "Replacing local uploads at $UPLOAD_DIR..."
  clear_container_directory "$UPLOAD_DIR"
  compose cp "$WORK_DIR/uploads/." "app:$UPLOAD_DIR"
  if [ "${RESTORE_E2E_INJECT_MISSING:-}" = "1" ]; then
    echo "Injecting post-restore storage drift for E2E drill..."
    if [ -n "${RESTORE_E2E_MISSING_OBJECT_KEY:-}" ]; then
      remove_container_object "$UPLOAD_DIR" "$RESTORE_E2E_MISSING_OBJECT_KEY" \
        || fail "failed to inject missing-object drift for E2E drill"
    else
      remove_first_container_text_file "$UPLOAD_DIR" \
        || fail "failed to inject missing-object drift for E2E drill"
    fi
  fi
else
  echo "Archive was created for S3/R2; local uploads were not included."
  if [ "${RESTORE_E2E_INJECT_MISSING:-}" = "1" ] && [ -n "${RESTORE_E2E_MISSING_OBJECT_KEY:-}" ]; then
    echo "Injecting S3 missing-object drift for E2E drill..."
    INJECT_ARGS="--missing=$RESTORE_E2E_MISSING_OBJECT_KEY"
    if [ -n "${RESTORE_E2E_ORPHAN_OBJECT_KEY:-}" ]; then
      INJECT_ARGS="$INJECT_ARGS --orphan=$RESTORE_E2E_ORPHAN_OBJECT_KEY"
    fi
    # shellcheck disable=SC2086
    compose run --rm -T --no-deps \
      --entrypoint node app /app/dist/inject-restore-s3-drift.mjs $INJECT_ARGS \
      || fail "failed to inject S3 storage drift for E2E drill"
  fi
fi

echo "Running forward migrator in one-off container..."
run_one_off /app/dist/migrate.mjs || fail "forward migrator failed"

echo "Pre-scanning referenced objects and quarantining missing files..."
run_one_off /app/dist/restore-pre-scan.mjs || fail "restore pre-scan failed"

echo "Applying mandatory file-safety backfill..."
run_one_off /app/dist/files-backfill.mjs --apply || fail "file-safety backfill failed"

echo "Neutralizing restored tasks and payment-provider events..."
run_one_off /app/dist/restore-neutralize.mjs || fail "restore neutralization failed"

echo "Converging database and storage references..."
CONVERGE_ARGS=""
if [ -n "${RESTORE_S3_ENUM_PREFIXES:-}" ]; then
  CONVERGE_ARGS="--prefixes=$RESTORE_S3_ENUM_PREFIXES"
fi
if [ -n "${RESTORE_CONVERGE_MAX_OBJECTS:-}" ]; then
  CONVERGE_ARGS="$CONVERGE_ARGS --max-objects=$RESTORE_CONVERGE_MAX_OBJECTS"
fi
if [ -n "${RESTORE_CONVERGE_PAGE_SIZE:-}" ]; then
  CONVERGE_ARGS="$CONVERGE_ARGS --page-size=$RESTORE_CONVERGE_PAGE_SIZE"
fi
# shellcheck disable=SC2086
run_one_off /app/dist/restore-converge.mjs $CONVERGE_ARGS || fail "restore convergence failed"

echo "Starting application..."
compose up -d --force-recreate app

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
echo "Review Stripe/payment state near the archive timestamp and verify convergence output above."
