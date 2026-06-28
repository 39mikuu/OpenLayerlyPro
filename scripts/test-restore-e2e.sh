#!/bin/sh
# shellcheck disable=SC2016
set -eu

umask 077

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

SOURCE_PROJECT=${SOURCE_PROJECT:-openlayerlypro_s7_source}
RESTORE_PROJECT=${RESTORE_PROJECT:-openlayerlypro_s7_restore}
SOURCE_PORT=${SOURCE_PORT:-3003}
RESTORE_PORT=${RESTORE_PORT:-3004}
BACKUP_DIR=${BACKUP_DIR:-/tmp/openlayerlypro-s7-e2e-backups}
DRILL_ENV=${DRILL_ENV:-.env.s7-e2e}
NESTED_UPLOAD_DIR=${NESTED_UPLOAD_DIR:-/app/uploads/e2e-nested}

fail() {
  echo "restore-e2e: $*" >&2
  exit 1
}

compose() {
  project=$1
  shift
  sudo -n env COMPOSE_ENV_FILE="$DRILL_ENV" \
    S7_E2E_APP_PORT="${S7_E2E_APP_PORT:-3003}" docker compose \
    -p "$project" \
    --env-file "$DRILL_ENV" \
    -f docker-compose.yml \
    -f docker-compose.s7-e2e.yml \
    "$@"
}

wait_ready() {
  project=$1
  port=$2
  attempt=0
  while :; do
    if curl -fsS "http://127.0.0.1:${port}/api/ready" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 90 ] || fail "ready check timed out for ${project} on port ${port}"
    sleep 2
  done
}

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v node >/dev/null 2>&1 || fail "node is required"
sudo -n docker version >/dev/null 2>&1 || fail "passwordless sudo docker is required in this environment"

DOCKER_SUDO_BIN=${DOCKER_SUDO_BIN:-/tmp/openlayerlypro-docker-sudo}
mkdir -p "$(dirname "$DOCKER_SUDO_BIN")"
printf '%s\n' '#!/bin/sh' 'exec sudo -n docker "$@"' >"$DOCKER_SUDO_BIN"
chmod +x "$DOCKER_SUDO_BIN"
PATH=$(dirname "$DOCKER_SUDO_BIN"):$PATH
export PATH

mkdir -p "$BACKUP_DIR"

cat >"$DRILL_ENV" <<EOF
APP_URL=http://127.0.0.1:3003
APP_NAME=OpenLayerlyPro S7 Restore Drill
NODE_ENV=production
SESSION_SECRET=s7-restore-e2e-session-secret-0123456789
SECURITY_CSP_MODE=auto
SECURITY_HSTS_ENABLED=false
CONFIG_ENCRYPTION_KEY=
CONFIG_ENCRYPTION_KEY_FILE=/app/secrets/config-encryption-key
DATABASE_URL=postgresql://artist:artist_password@postgres:5432/artist_member
STORAGE_DRIVER=local
UPLOAD_DIR=$NESTED_UPLOAD_DIR
TURNSTILE_ENABLED=false
EOF

if [ ! -f .env ]; then
  cp "$DRILL_ENV" .env
  CREATED_DOT_ENV=true
else
  CREATED_DOT_ENV=false
fi

teardown_projects() {
  for tp_project in "$SOURCE_PROJECT" "$RESTORE_PROJECT"; do
    sudo -n env COMPOSE_ENV_FILE="$DRILL_ENV" \
      docker compose -p "$tp_project" --env-file "$DRILL_ENV" \
      -f docker-compose.yml -f docker-compose.s7-e2e.yml down -v >/dev/null 2>&1 || true
  done
}

# Real teardown on every exit/signal: stop and remove all drill projects (containers +
# volumes) *before* deleting the env files they reference, so nothing is left running.
cleanup() {
  teardown_projects
  [ "$CREATED_DOT_ENV" = true ] && [ -f .env ] && rm -f .env
  rm -f "$DRILL_ENV"
  rm -rf "${CONTRACT_WORK:-}" "${UNSAFE_BACKUP_DIR:-}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Cleaning previous drill projects..."
teardown_projects

echo "Building source image..."
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" build app
echo "Tagging source image for restore project..."
sudo -n docker image inspect "openlayerlypro_s7_source-app:latest" >/dev/null 2>&1 \
  || fail "source app image was not built"
sudo -n docker tag openlayerlypro_s7_source-app:latest openlayerlypro_s7_restore-app:latest

echo "Starting source stack on port ${SOURCE_PORT} with UPLOAD_DIR=${NESTED_UPLOAD_DIR}..."
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" up -d postgres
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" up -d app
wait_ready "$SOURCE_PROJECT" "$SOURCE_PORT"

echo "Seeding source data..."
SEED_JSON=$(
  S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" run --rm --no-deps \
    --entrypoint node app /app/dist/seed-restore-e2e.mjs | awk '/^\{/,/^}/'
)
[ -n "$SEED_JSON" ] || fail "seed output missing JSON markers"
QUARANTINE_FILE_ID=$(printf '%s' "$SEED_JSON" | node -e 'const input=[];process.stdin.on("data",d=>input.push(d));process.stdin.on("end",()=>{const j=JSON.parse(Buffer.concat(input).toString());process.stdout.write(j.quarantineFileId);});')
INTACT_FILE_ID=$(printf '%s' "$SEED_JSON" | node -e 'const input=[];process.stdin.on("data",d=>input.push(d));process.stdin.on("end",()=>{const j=JSON.parse(Buffer.concat(input).toString());process.stdout.write(j.intactFileId);});')
MISSING_OBJECT_KEY="restore-e2e/${QUARANTINE_FILE_ID}.txt"
if [ -z "$QUARANTINE_FILE_ID" ] || [ -z "$INTACT_FILE_ID" ]; then
  fail "seed markers missing file ids"
fi

echo "Creating baseline backup..."
export COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml"
export COMPOSE_ENV_FILE="$DRILL_ENV"
compose "$SOURCE_PROJECT" exec -T app sh -c 'test -z "${CONFIG_ENCRYPTION_KEY:-}"' || fail "source uses direct CONFIG_ENCRYPTION_KEY"
COMPOSE_PROJECT_NAME=$SOURCE_PROJECT ./scripts/backup.sh "$BACKUP_DIR"
# shellcheck disable=SC2012 # controlled backup filenames; newest-by-mtime is intended
ARCHIVE=$(ls -1t "$BACKUP_DIR"/openlayerly-backup-*.tar.gz | head -n 1)
[ -n "$ARCHIVE" ] || fail "backup archive not found"

echo "Verifying backup rejects unsupported live upload entries without publishing an archive..."
UNSAFE_BACKUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-s7-unsafe-backup.XXXXXX")
compose "$SOURCE_PROJECT" exec -T app sh -c \
  'ln -s restore-e2e /app/uploads/e2e-nested/unsafe-symlink'
if COMPOSE_PROJECT_NAME=$SOURCE_PROJECT ./scripts/backup.sh "$UNSAFE_BACKUP_DIR" >/dev/null 2>&1; then
  fail "backup unexpectedly accepted a symlink in the live upload tree"
fi
if find "$UNSAFE_BACKUP_DIR" -name 'openlayerly-backup-*.tar.gz' -print -quit | grep -q .; then
  fail "backup published an archive after rejecting a live upload symlink"
fi
compose "$SOURCE_PROJECT" exec -T app rm -f /app/uploads/e2e-nested/unsafe-symlink
compose "$SOURCE_PROJECT" exec -T app mkfifo /app/uploads/e2e-nested/unsafe-fifo
if COMPOSE_PROJECT_NAME=$SOURCE_PROJECT ./scripts/backup.sh "$UNSAFE_BACKUP_DIR" >/dev/null 2>&1; then
  fail "backup unexpectedly accepted a FIFO in the live upload tree"
fi
if find "$UNSAFE_BACKUP_DIR" -name 'openlayerly-backup-*.tar.gz' -print -quit | grep -q .; then
  fail "backup published an archive after rejecting a live upload FIFO"
fi
compose "$SOURCE_PROJECT" exec -T app rm -f /app/uploads/e2e-nested/unsafe-fifo
rm -rf "$UNSAFE_BACKUP_DIR"

echo "Stopping source app before restore target comes online..."
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" stop app

echo "Starting isolated restore stack on port ${RESTORE_PORT}..."
S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" up -d postgres
S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" create app >/dev/null

echo "Verifying malformed storage contracts cannot alter the official DB or key..."
POSTGRES_ATTEMPT=0
until S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" exec -T postgres sh -c \
  'exec pg_isready -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" >/dev/null'; do
  POSTGRES_ATTEMPT=$((POSTGRES_ATTEMPT + 1))
  [ "$POSTGRES_ATTEMPT" -lt 60 ] || fail "restore PostgreSQL did not become ready"
  sleep 2
done
S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" exec -T postgres sh -c '
  exec psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
    -c "create table restore_contract_sentinel (value text not null); insert into restore_contract_sentinel values (chr(117)||chr(110)||chr(116)||chr(111)||chr(117)||chr(99)||chr(104)||chr(101)||chr(100));"
'
S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" run --rm --no-deps \
  --entrypoint sh app -c \
  'printf contract-key-untouched > /app/secrets/config-encryption-key'
CONTRACT_WORK=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-s7-contract.XXXXXX")
for variant in missing both mismatch; do
  mkdir -p "$CONTRACT_WORK/$variant"
  tar -xzf "$ARCHIVE" -C "$CONTRACT_WORK/$variant"
  case "$variant" in
    missing)
      rm -rf "$CONTRACT_WORK/$variant/uploads"
      rm -f "$CONTRACT_WORK/$variant/UPLOADS_SKIPPED_S3"
      ;;
    both)
      touch "$CONTRACT_WORK/$variant/UPLOADS_SKIPPED_S3"
      ;;
    mismatch)
      rm -rf "$CONTRACT_WORK/$variant/uploads"
      touch "$CONTRACT_WORK/$variant/UPLOADS_SKIPPED_S3"
      ;;
  esac
  (
    cd "$CONTRACT_WORK/$variant" || exit 1
    find . -type f ! -path './checksums.sha256' -print | LC_ALL=C sort \
      | while IFS= read -r path; do sha256sum "${path#./}"; done \
      > checksums.sha256
    tar -czf "../$variant.tar.gz" .
  )
  if S7_E2E_APP_PORT=$RESTORE_PORT \
    COMPOSE_PROJECT_NAME=$RESTORE_PROJECT \
    COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml" \
    COMPOSE_ENV_FILE="$DRILL_ENV" \
    ./scripts/restore.sh "$CONTRACT_WORK/$variant.tar.gz" --yes >/dev/null 2>&1; then
    fail "restore unexpectedly accepted malformed storage contract: $variant"
  fi
  SENTINEL_DB=$(
    S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" exec -T postgres sh -c '
      exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
        -c "select value from restore_contract_sentinel;"
    '
  )
  [ "$SENTINEL_DB" = "untouched" ] || fail "malformed $variant archive changed official database"
  SENTINEL_KEY=$(
    S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" run --rm --no-deps \
      --entrypoint sh app -c 'cat /app/secrets/config-encryption-key'
  )
  [ "$SENTINEL_KEY" = "contract-key-untouched" ] \
    || fail "malformed $variant archive changed official config key"
done
rm -rf "$CONTRACT_WORK"
CONTRACT_WORK=""

echo "Running hardened restore into ${RESTORE_PROJECT}..."
S7_E2E_APP_PORT=$RESTORE_PORT \
  COMPOSE_PROJECT_NAME=$RESTORE_PROJECT \
  COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml" \
  COMPOSE_ENV_FILE="$DRILL_ENV" \
  RESTORE_E2E_INJECT_MISSING=1 \
  RESTORE_E2E_MISSING_OBJECT_KEY="$MISSING_OBJECT_KEY" \
  READY_URL="http://127.0.0.1:${RESTORE_PORT}/api/ready" \
  ./scripts/restore.sh "$ARCHIVE" --yes

echo "Verifying restored content..."
READY_BODY=$(curl -fsS "http://127.0.0.1:${RESTORE_PORT}/api/ready")
echo "$READY_BODY" | grep -q '"ok":true' || fail "ready body was not ok: $READY_BODY"

POST_COUNT=$(
  S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" exec -T postgres sh -c '
    exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
      -c "select count(*) from posts where slug = '"'"'restore-e2e-marker'"'"';"
  '
)
[ "$POST_COUNT" = "1" ] || fail "restored post missing (count=$POST_COUNT)"

DELETE_TASK_COUNT=$(
  S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" exec -T postgres sh -c '
    exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
      -c "select count(*) from tasks where kind = '"'"'storage.delete_object'"'"';"
  '
)
[ "$DELETE_TASK_COUNT" = "0" ] || fail "restored storage.delete_object tasks still present (count=$DELETE_TASK_COUNT)"

QUARANTINE_COUNT=$(
  S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" exec -T postgres sh -c '
    exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
      -c "select count(*) from files where quarantine_reason = '"'"'missing after restore'"'"';"
  '
)
[ "$QUARANTINE_COUNT" = "1" ] || fail "expected one missing-after-restore quarantine (count=$QUARANTINE_COUNT)"

S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" run --rm --no-deps \
  -e DATABASE_URL=postgresql://artist:artist_password@postgres:5432/artist_member \
  -e QUARANTINE_FILE_ID="$QUARANTINE_FILE_ID" \
  -e INTACT_FILE_ID="$INTACT_FILE_ID" \
  -e RESTORE_APP_URL=http://app:3000 \
  --entrypoint node app /app/dist/verify-restore-e2e.mjs

echo "S7 restore E2E drill passed."
echo "Archive: $ARCHIVE"
echo "Source project: $SOURCE_PROJECT (port $SOURCE_PORT)"
echo "Restore project: $RESTORE_PROJECT (port $RESTORE_PORT)"
echo "Nested upload dir: $NESTED_UPLOAD_DIR"
