#!/bin/sh
# shellcheck disable=SC2016
# End-to-end drill for the legacy FORMAT_VERSION=1 restore path through restore.sh.
# Exercises the shell path the module/integration tests cannot: the isolated schema
# probe with *custom, URL-reserved* PostgreSQL credentials (validates credential
# percent-encoding and reading creds from the container), plus success / unknown-schema
# failure / --allow override, and probe-database cleanup on success, failure, and signal.
set -eu

umask 077

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

SRC_PROJECT=${SRC_PROJECT:-openlayerlypro_s7_v1_source}
RST_PROJECT=${RST_PROJECT:-openlayerlypro_s7_v1_restore}
SRC_PORT=${SRC_PORT:-3009}
RST_PORT=${RST_PORT:-3010}
BACKUP_DIR=${BACKUP_DIR:-/tmp/openlayerlypro-s7-v1-e2e-backups}
DRILL_ENV=${DRILL_ENV:-.env.s7-v1-e2e}
OVERRIDE=${OVERRIDE:-/tmp/openlayerly-s7-v1-override.yml}
WORK=${WORK:-/tmp/openlayerly-s7-v1-work}

# Custom credentials containing URL-reserved characters. The app's DATABASE_URL carries
# the percent-encoded form; restore.sh must read the *raw* POSTGRES_PASSWORD from the
# container and re-encode it identically for the probe connection.
PG_USER='s7_v1_user'
PG_PASSWORD='p@ss:w0rd/v1#x'
PG_PASSWORD_ENC='p%40ss%3Aw0rd%2Fv1%23x'
PG_DB='artist_member'

fail() {
  echo "restore-v1-e2e: $*" >&2
  exit 1
}

v1_compose() {
  project=$1
  shift
  sudo -n env COMPOSE_ENV_FILE="$DRILL_ENV" \
    S7_E2E_APP_PORT="${S7_E2E_APP_PORT:-$SRC_PORT}" \
    docker compose -p "$project" --env-file "$DRILL_ENV" \
    -f docker-compose.yml -f docker-compose.s7-e2e.yml -f "$OVERRIDE" \
    "$@"
}

wait_ready() {
  port=$1
  attempt=0
  while :; do
    if curl -fsS "http://127.0.0.1:${port}/api/ready" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 90 ] || fail "ready check timed out on port ${port}"
    sleep 2
  done
}

# Count isolated schema-probe databases currently present on the restore stack.
probe_db_count() {
  S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" exec -T postgres sh -c '
    exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
      -c "select count(*) from pg_database where datname like '"'"'openlayerly_restore_probe_%'"'"';"
  ' 2>/dev/null | tr -d '\r'
}

assert_no_probe_db() {
  context=$1
  count=$(probe_db_count)
  [ "$count" = "0" ] || fail "probe database leaked after $context (count=$count)"
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
sudo -n docker version >/dev/null 2>&1 || fail "passwordless sudo docker is required in this environment"

DOCKER_SUDO_BIN=${DOCKER_SUDO_BIN:-/tmp/openlayerlypro-docker-sudo}
mkdir -p "$(dirname "$DOCKER_SUDO_BIN")"
printf '%s\n' '#!/bin/sh' 'exec sudo -n docker "$@"' >"$DOCKER_SUDO_BIN"
chmod +x "$DOCKER_SUDO_BIN"
PATH=$(dirname "$DOCKER_SUDO_BIN"):$PATH
export PATH

mkdir -p "$BACKUP_DIR"
rm -rf "$WORK"
mkdir -p "$WORK"

cat >"$DRILL_ENV" <<EOF
APP_URL=http://127.0.0.1:$SRC_PORT
APP_NAME=OpenLayerlyPro S7 v1 Restore Drill
NODE_ENV=production
SESSION_SECRET=s7-restore-v1-e2e-session-secret-0123456789
SECURITY_CSP_MODE=auto
SECURITY_HSTS_ENABLED=false
CONFIG_ENCRYPTION_KEY=
CONFIG_ENCRYPTION_KEY_FILE=/app/secrets/config-encryption-key
STORAGE_DRIVER=local
UPLOAD_DIR=/app/uploads
TURNSTILE_ENABLED=false
EOF

# Custom-credential override: the postgres service uses URL-reserved credentials and the
# app connects via a percent-encoded DATABASE_URL.
cat >"$OVERRIDE" <<EOF
services:
  postgres:
    environment:
      POSTGRES_DB: $PG_DB
      POSTGRES_USER: $PG_USER
      POSTGRES_PASSWORD: "$PG_PASSWORD"
  app:
    environment:
      DATABASE_URL: "postgresql://$PG_USER:$PG_PASSWORD_ENC@postgres:5432/$PG_DB"
EOF

if [ ! -f .env ]; then
  cp "$DRILL_ENV" .env
  CREATED_DOT_ENV=true
else
  CREATED_DOT_ENV=false
fi

cleanup() {
  # Tear projects down *before* removing the override/env files that v1_compose needs.
  for project in "$SRC_PROJECT" "$RST_PROJECT"; do
    S7_E2E_APP_PORT=$SRC_PORT v1_compose "$project" down -v >/dev/null 2>&1 || true
  done
  [ "$CREATED_DOT_ENV" = true ] && [ -f .env ] && rm -f .env
  rm -f "$OVERRIDE" "$DRILL_ENV"
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Cleaning previous v1 drill projects..."
for project in "$SRC_PROJECT" "$RST_PROJECT"; do
  S7_E2E_APP_PORT=$SRC_PORT v1_compose "$project" down -v >/dev/null 2>&1 || true
done

echo "Building source image (e2e-runner)..."
S7_E2E_APP_PORT=$SRC_PORT v1_compose "$SRC_PROJECT" build app
sudo -n docker image inspect "${SRC_PROJECT}-app:latest" >/dev/null 2>&1 \
  || fail "source app image was not built"
sudo -n docker tag "${SRC_PROJECT}-app:latest" "${RST_PROJECT}-app:latest"

echo "Starting source stack with custom credentials on port ${SRC_PORT}..."
S7_E2E_APP_PORT=$SRC_PORT v1_compose "$SRC_PROJECT" up -d postgres
S7_E2E_APP_PORT=$SRC_PORT v1_compose "$SRC_PROJECT" up -d app
wait_ready "$SRC_PORT"

echo "Creating baseline backup, then converting it to a FORMAT_VERSION=1 archive..."
export COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml:$OVERRIDE"
export COMPOSE_ENV_FILE="$DRILL_ENV"
COMPOSE_PROJECT_NAME=$SRC_PROJECT S7_E2E_APP_PORT=$SRC_PORT ./scripts/backup.sh "$BACKUP_DIR"
# shellcheck disable=SC2012 # controlled backup filenames; newest-by-mtime is intended
V2_ARCHIVE=$(ls -1t "$BACKUP_DIR"/openlayerly-backup-*.tar.gz | head -n 1)
[ -n "$V2_ARCHIVE" ] || fail "baseline backup archive not found"

# Compatible v1 archive: drop checksums + set FORMAT_VERSION=1.
tar -xzf "$V2_ARCHIVE" -C "$WORK"
rm -f "$WORK/checksums.sha256"
sed -i 's/^FORMAT_VERSION=.*/FORMAT_VERSION=1/' "$WORK/manifest.env"
V1_OK="$BACKUP_DIR/v1-compatible.tar.gz"
tar -czf "$V1_OK" -C "$WORK" .

# Unknown-schema v1 archive: same payload, but the probe cannot read the migration
# history (drizzle.__drizzle_migrations dropped after load) -> compatibility "unknown".
printf '\nDROP TABLE IF EXISTS drizzle.__drizzle_migrations;\nDROP SCHEMA IF EXISTS drizzle CASCADE;\n' \
  >>"$WORK/db.sql"
V1_UNKNOWN="$BACKUP_DIR/v1-unknown.tar.gz"
tar -czf "$V1_UNKNOWN" -C "$WORK" .

# True historical (pre-session-secret) archive: strip every session-secret manifest field
# and ensure no archived session-secret file exists, so restore.sh takes the real `legacy`
# branch instead of `external`/`file`. Extract from the V1_OK *archive* (its db.sql predates
# the unknown-schema DROP appended to $WORK/db.sql above).
echo "Building a true historical (legacy) FORMAT_VERSION=1 fixture..."
LEGACY_WORK="$WORK/legacy"
mkdir -p "$LEGACY_WORK"
tar -xzf "$V1_OK" -C "$LEGACY_WORK"
grep -vE '^(SESSION_SECRET_SOURCE|SESSION_SECRET_SHA256|SESSION_SECRET_FILE|SESSION_SECRET_ARCHIVE_PATH)=' \
  "$LEGACY_WORK/manifest.env" > "$LEGACY_WORK/manifest.env.new"
mv "$LEGACY_WORK/manifest.env.new" "$LEGACY_WORK/manifest.env"
rm -f "$LEGACY_WORK/secrets/session-secret"
if grep -q '^SESSION_SECRET' "$LEGACY_WORK/manifest.env"; then
  fail "legacy fixture still declares session-secret manifest fields"
fi
[ ! -e "$LEGACY_WORK/secrets/session-secret" ] \
  || fail "legacy fixture still contains an archived session secret"
[ -s "$LEGACY_WORK/db.sql" ] || fail "legacy fixture is missing db.sql"
[ -s "$LEGACY_WORK/secrets/config-encryption-key" ] \
  || fail "legacy fixture is missing the config encryption key"
[ -d "$LEGACY_WORK/uploads" ] || fail "legacy fixture is missing uploads"
V1_LEGACY="$BACKUP_DIR/v1-legacy.tar.gz"
tar -czf "$V1_LEGACY" -C "$LEGACY_WORK" .

echo "Stopping source app before restore target comes online..."
S7_E2E_APP_PORT=$SRC_PORT v1_compose "$SRC_PROJECT" stop app

start_restore_stack() {
  S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" down -v >/dev/null 2>&1 || true
  S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" up -d postgres
  attempt=0
  until S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" exec -T postgres sh -c \
    'exec pg_isready -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" >/dev/null'; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 60 ] || fail "restore postgres did not become ready"
    sleep 2
  done
  S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" create app >/dev/null
}

run_restore() {
  run_restore_with_env "$DRILL_ENV" "$@"
}

# Run restore.sh against the restore stack with an explicit COMPOSE_ENV_FILE, so legacy
# cases can vary only the target SESSION_SECRET (missing/short/placeholder/whitespace/valid)
# while reusing the same postgres credentials and DATABASE_URL from the override file.
run_restore_with_env() {
  rrwe_env=$1
  shift
  S7_E2E_APP_PORT=$RST_PORT \
    COMPOSE_PROJECT_NAME=$RST_PROJECT \
    COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml:$OVERRIDE" \
    COMPOSE_ENV_FILE="$rrwe_env" \
    READY_URL="http://127.0.0.1:${RST_PORT}/api/ready" \
    ./scripts/restore.sh "$@"
}

# Derive a target env from the drill env with a specific SESSION_SECRET shape. Used to prove
# the legacy branch validates strength (not just presence) before any destructive work.
make_legacy_env() {
  ml_out=$1
  ml_mode=$2
  grep -v '^SESSION_SECRET=' "$DRILL_ENV" > "$ml_out"
  case "$ml_mode" in
    missing) : ;;
    short) echo 'SESSION_SECRET=short' >> "$ml_out" ;;
    placeholder) echo 'SESSION_SECRET=change-me' >> "$ml_out" ;;
    whitespace) printf 'SESSION_SECRET="%s"\n' '                                ' >> "$ml_out" ;;
    valid) echo 'SESSION_SECRET=legacy-explicit-session-secret-0123456789' >> "$ml_out" ;;
    *) fail "unknown legacy env mode: $ml_mode" ;;
  esac
}

# Seed a database row and a config-key file sentinel on the restore stack so a rejected
# legacy restore can be proven non-destructive (DB + key + session-secret target intact).
seed_legacy_sentinels() {
  S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" exec -T postgres sh -c '
    exec psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
      -c "drop table if exists restore_legacy_sentinel;
          create table restore_legacy_sentinel (value text not null);
          insert into restore_legacy_sentinel values ('"'"'untouched'"'"');"
  '
  S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" run --rm --no-deps -T \
    --entrypoint sh app -c 'printf legacy-key-untouched > /app/secrets/config-encryption-key'
}

# Assert the official DB row, config key, and session-secret target were untouched by a
# rejected legacy restore, that the app never became ready, and no probe DB leaked.
assert_legacy_sentinels_untouched() {
  alsu_ctx=$1
  alsu_db=$(
    S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" exec -T postgres sh -c '
      exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
        -c "select value from restore_legacy_sentinel;"
    ' 2>/dev/null | tr -d '\r'
  )
  [ "$alsu_db" = "untouched" ] \
    || fail "legacy $alsu_ctx changed the official database (sentinel='$alsu_db')"
  alsu_key=$(
    S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" run --rm --no-deps -T \
      --entrypoint sh app -c 'cat /app/secrets/config-encryption-key 2>/dev/null || true' | tr -d '\r'
  )
  [ "$alsu_key" = "legacy-key-untouched" ] \
    || fail "legacy $alsu_ctx changed the official config encryption key"
  S7_E2E_APP_PORT=$RST_PORT v1_compose "$RST_PROJECT" run --rm --no-deps -T \
    --entrypoint sh app -c '[ ! -e /app/secrets/session-secret ]' \
    || fail "legacy $alsu_ctx created or modified the session secret target"
  if curl -fsS "http://127.0.0.1:${RST_PORT}/api/ready" >/dev/null 2>&1; then
    fail "app became ready after a rejected legacy restore ($alsu_ctx)"
  fi
  assert_no_probe_db "legacy $alsu_ctx"
}

# --- Signal cleanup: interrupt mid-restore and prove the probe DB is not orphaned. ---
echo "TEST: probe database is cleaned up when restore is signalled..."
start_restore_stack
run_restore "$V1_OK" --yes >/tmp/openlayerly-s7-v1-signal.log 2>&1 &
RESTORE_PID=$!
seen_probe=false
attempt=0
while [ "$attempt" -lt 100 ]; do
  if ! kill -0 "$RESTORE_PID" 2>/dev/null; then break; fi
  if [ "$(probe_db_count)" != "0" ]; then
    seen_probe=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
kill -TERM "$RESTORE_PID" 2>/dev/null || true
wait "$RESTORE_PID" 2>/dev/null && signal_rc=0 || signal_rc=$?
[ "$signal_rc" != "0" ] || fail "signalled restore unexpectedly exited 0"
# Allow the trap-driven cleanup to settle, then assert no probe DB remains.
sleep 3
assert_no_probe_db "SIGTERM during restore"
[ "$seen_probe" = true ] && echo "  (probe DB was observed and then cleaned up after SIGTERM)" \
  || echo "  (probe window not caught; asserted no orphaned probe DB after SIGTERM)"

# --- Unknown schema must fail closed (no --allow), DB untouched, probe cleaned up. ---
echo "TEST: unknown-schema v1 archive fails closed without --allow..."
start_restore_stack
if run_restore "$V1_UNKNOWN" --yes >/tmp/openlayerly-s7-v1-unknown.log 2>&1; then
  fail "unknown-schema v1 restore unexpectedly succeeded without override"
fi
grep -qi 'schema compatibility check failed' /tmp/openlayerly-s7-v1-unknown.log \
  || fail "unknown-schema failure did not surface as a schema compatibility error"
if curl -fsS "http://127.0.0.1:${RST_PORT}/api/ready" >/dev/null 2>&1; then
  fail "app became ready after an unknown-schema restore failure"
fi
assert_no_probe_db "unknown-schema failure"

# --- --allow override must get past the schema-check gate. ---
echo "TEST: --allow-legacy-v1-unknown-schema overrides the unknown-schema gate..."
start_restore_stack
run_restore "$V1_UNKNOWN" --yes --allow-legacy-v1-unknown-schema \
  >/tmp/openlayerly-s7-v1-override.log 2>&1 || true
grep -qi 'LEGACY OVERRIDE' /tmp/openlayerly-s7-v1-override.log \
  || fail "override did not emit the LEGACY OVERRIDE acknowledgement"
if grep -qi 'schema compatibility check failed' /tmp/openlayerly-s7-v1-override.log; then
  fail "override was not honoured; schema-check still blocked the restore"
fi
assert_no_probe_db "override past schema-check"

# --- Compatible archive with custom credentials restores successfully end to end. ---
echo "TEST: compatible v1 archive restores successfully with custom credentials..."
start_restore_stack
run_restore "$V1_OK" --yes >/tmp/openlayerly-s7-v1-success.log 2>&1 \
  || fail "compatible v1 restore failed (see /tmp/openlayerly-s7-v1-success.log)"
READY_BODY=$(curl -fsS "http://127.0.0.1:${RST_PORT}/api/ready")
echo "$READY_BODY" | grep -q '"ok":true' || fail "v1 restore ready body was not ok: $READY_BODY"
assert_no_probe_db "successful v1 restore"

# --- Real historical archive: strict SESSION_SECRET preflight before destructive work. ---
for legacy_case in missing short placeholder whitespace; do
  echo "TEST: legacy archive rejects a $legacy_case SESSION_SECRET before destructive work..."
  start_restore_stack
  seed_legacy_sentinels
  CASE_ENV="$WORK/.env.legacy-$legacy_case"
  make_legacy_env "$CASE_ENV" "$legacy_case"
  CASE_LOG="/tmp/openlayerly-s7-v1-legacy-$legacy_case.log"
  if run_restore_with_env "$CASE_ENV" "$V1_LEGACY" --yes >"$CASE_LOG" 2>&1; then
    fail "legacy restore unexpectedly accepted a $legacy_case SESSION_SECRET"
  fi
  grep -qi 'historical archive requires an explicit strong SESSION_SECRET' "$CASE_LOG" \
    || fail "legacy $legacy_case failure did not surface the strong-secret requirement"
  assert_legacy_sentinels_untouched "$legacy_case rejection"
  rm -f "$CASE_ENV"
done

echo "TEST: legacy archive with an explicit strong SESSION_SECRET restores successfully..."
start_restore_stack
CASE_ENV="$WORK/.env.legacy-valid"
make_legacy_env "$CASE_ENV" valid
if ! run_restore_with_env "$CASE_ENV" "$V1_LEGACY" --yes \
    >/tmp/openlayerly-s7-v1-legacy-valid.log 2>&1; then
  fail "legacy restore with a strong SESSION_SECRET failed (see /tmp/openlayerly-s7-v1-legacy-valid.log)"
fi
grep -qi 'historical archive cannot verify whether SESSION_SECRET matches the original' \
  /tmp/openlayerly-s7-v1-legacy-valid.log \
  || fail "legacy success did not emit the continuity warning"
LEGACY_READY_BODY=$(curl -fsS "http://127.0.0.1:${RST_PORT}/api/ready")
echo "$LEGACY_READY_BODY" | grep -q '"ok":true' \
  || fail "legacy restore ready body was not ok: $LEGACY_READY_BODY"
assert_no_probe_db "successful legacy restore"
rm -f "$CASE_ENV"

echo "S7 v1 restore E2E drill passed."
echo "Compatible archive: $V1_OK"
echo "Unknown archive: $V1_UNKNOWN"
echo "Legacy (historical) archive: $V1_LEGACY"
echo "Custom DB user: $PG_USER (URL-reserved password)"
