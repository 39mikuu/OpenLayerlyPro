#!/bin/sh
# shellcheck disable=SC2016 # Expand Compose service variables inside the container shell.
set -eu

umask 077

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
      ${S7_E2E_APP_PORT:+S7_E2E_APP_PORT=$S7_E2E_APP_PORT} \
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
    compose exec -T postgres sh -c "
      set -eu
      dropdb --if-exists --force -U \"\${POSTGRES_USER:-artist}\" \"$PROBE_DB\" >/dev/null 2>&1 || true
    " >/dev/null 2>&1 || true
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
if [ -n "$(find "$WORK_DIR" -type l -print -quit 2>/dev/null || true)" ]; then
  fail "archive contains symlinks; only regular payload files are supported"
fi
if [ -n "$(find "$WORK_DIR" \( -type b -o -type c -o -type p -o -type s \) -print -quit 2>/dev/null || true)" ]; then
  fail "archive contains special files; only regular payload files are supported"
fi
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
    awk '{print $2}' checksums.sha256 | LC_ALL=C sort > "$CHECKSUM_FILE_LIST"
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

compose stop app >/dev/null 2>&1 || true
compose create app >/dev/null

if ! compose run --rm -T --no-deps --entrypoint sh app -c 'test -z "${CONFIG_ENCRYPTION_KEY:-}"'; then
  fail "target defines CONFIG_ENCRYPTION_KEY; unset it or restore the matching externally managed value before continuing"
fi

if [ "$FORMAT_VERSION" = "1" ]; then
  PROBE_DB="openlayerly_restore_probe_${TIMESTAMP:-$(date +%s)}_$$"
  echo "Probing legacy archive schema compatibility in isolated database $PROBE_DB..."
  compose exec -T postgres sh -c "
    set -eu
    createdb -U \"\${POSTGRES_USER:-artist}\" \"$PROBE_DB\"
  "
  compose exec -T postgres sh -c "
    set -eu
    exec psql -v ON_ERROR_STOP=1 -U \"\${POSTGRES_USER:-artist}\" -d \"$PROBE_DB\"
  " < "$WORK_DIR/db.sql"

  PROBE_DATABASE_URL="postgresql://${POSTGRES_USER:-artist}:${POSTGRES_PASSWORD:-artist_password}@postgres:5432/$PROBE_DB"
  if ! run_schema_check --database-url="$PROBE_DATABASE_URL" --format-version="$FORMAT_VERSION"; then
    fail "legacy archive schema compatibility check failed"
  fi
  compose exec -T postgres sh -c "
    set -eu
    dropdb --if-exists --force -U \"\${POSTGRES_USER:-artist}\" \"$PROBE_DB\"
  "
  PROBE_DB=""
else
  echo "Checking archive migration compatibility from manifest..."
  if ! run_schema_check --manifest-path=/restore-work/manifest.env --format-version="$FORMAT_VERSION"; then
    fail "archive schema compatibility check failed"
  fi
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
TARGET_CONFIG_KEY_FILE=$(
  compose run --rm -T --no-deps --entrypoint sh app -c \
    'printf %s "${CONFIG_ENCRYPTION_KEY_FILE:-/app/secrets/config-encryption-key}"'
)
case "$TARGET_CONFIG_KEY_FILE" in
  /app/secrets/*) ;;
  *) fail "CONFIG_ENCRYPTION_KEY_FILE must be an absolute path under /app/secrets for persistent restore" ;;
esac
TARGET_CONFIG_KEY_DIR=${TARGET_CONFIG_KEY_FILE%/*}
compose run --rm -T --no-deps --entrypoint sh app -c "
  set -eu
  mkdir -p \"$TARGET_CONFIG_KEY_DIR\"
"
compose cp "$WORK_DIR/secrets/config-encryption-key" "app:$TARGET_CONFIG_KEY_FILE"
compose run --rm -T --no-deps --entrypoint sh app -c "
  set -eu
  test -s \"$TARGET_CONFIG_KEY_FILE\"
"

if [ -d "$WORK_DIR/uploads" ]; then
  echo "Replacing local uploads..."
  compose run --rm -T --no-deps --entrypoint sh app -c '
    set -eu
    upload_dir=${UPLOAD_DIR:-/app/uploads}
    mkdir -p "$upload_dir"
    rm -rf "$upload_dir"/* "$upload_dir"/.[!.]* "$upload_dir"/..?*
  '
  compose cp "$WORK_DIR/uploads/." app:/app/uploads
  if [ "${RESTORE_E2E_INJECT_MISSING:-}" = "1" ]; then
    echo "Injecting post-restore storage drift for E2E drill..."
    compose run --rm -T --no-deps --entrypoint sh app -c '
      set -eu
      upload_dir=${UPLOAD_DIR:-/app/uploads}
      referenced=$(find "$upload_dir" -type f -name "*.txt" | head -n 1)
      [ -n "$referenced" ] || exit 1
      rm -f "$referenced"
    ' || fail "failed to inject missing-object drift for E2E drill"
  fi
elif [ -f "$WORK_DIR/UPLOADS_SKIPPED_S3" ]; then
  echo "Archive was created for S3/R2; local uploads were not included."
else
  fail "archive contains neither uploads nor the S3 skip marker"
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