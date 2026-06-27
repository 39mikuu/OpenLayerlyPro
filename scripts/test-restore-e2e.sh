#!/bin/sh
# shellcheck disable=SC2016
set -eu

umask 077

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

SOURCE_PROJECT=${SOURCE_PROJECT:-openlayerlypro_s7_source}
RESTORE_PROJECT=${RESTORE_PROJECT:-openlayerlypro_s7_restore}
SOURCE_PORT=${SOURCE_PORT:-3003}
RESTORE_PORT=${RESTORE_PORT:-3004}
BACKUP_DIR=${BACKUP_DIR:-/tmp/openlayerlypro-s7-e2e-backups}
DRILL_ENV=${DRILL_ENV:-.env.s7-e2e}

fail() {
  echo "restore-e2e: $*" >&2
  exit 1
}

compose() {
  project=$1
  shift
  S7_E2E_APP_PORT=${S7_E2E_APP_PORT:-3003} sudo -n docker compose \
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
sudo -n docker version >/dev/null 2>&1 || fail "passwordless sudo docker is required in this environment"

DOCKER_SUDO_BIN=${DOCKER_SUDO_BIN:-/tmp/openlayerlypro-docker-sudo}
mkdir -p "$(dirname "$DOCKER_SUDO_BIN")"
printf '%s\n' '#!/bin/sh' 'exec sudo -n docker "$@"' >"$DOCKER_SUDO_BIN"
chmod +x "$DOCKER_SUDO_BIN"
PATH=$(dirname "$DOCKER_SUDO_BIN"):$PATH
export PATH

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DRILL_ENV" ]; then
  cat >"$DRILL_ENV" <<'EOF'
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
UPLOAD_DIR=/app/uploads
TURNSTILE_ENABLED=false
EOF
fi

if [ ! -f .env ]; then
  cp "$DRILL_ENV" .env
  CREATED_DOT_ENV=true
else
  CREATED_DOT_ENV=false
fi

cleanup_dotenv() {
  if [ "$CREATED_DOT_ENV" = true ] && [ -f .env ]; then
    rm -f .env
  fi
}
trap cleanup_dotenv 0 HUP INT TERM

echo "Cleaning previous drill projects..."
sudo -n docker compose -p "$SOURCE_PROJECT" --env-file "$DRILL_ENV" \
  -f docker-compose.yml -f docker-compose.s7-e2e.yml down -v >/dev/null 2>&1 || true
sudo -n docker compose -p "$RESTORE_PROJECT" --env-file "$DRILL_ENV" \
  -f docker-compose.yml -f docker-compose.s7-e2e.yml down -v >/dev/null 2>&1 || true

echo "Building source image..."
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" build app
echo "Tagging source image for restore project..."
sudo -n docker image inspect "openlayerlypro_s7_source-app:latest" >/dev/null 2>&1 \
  || fail "source app image was not built"
sudo -n docker tag openlayerlypro_s7_source-app:latest openlayerlypro_s7_restore-app:latest

echo "Starting source stack on port ${SOURCE_PORT}..."
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" up -d postgres
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" up -d app
wait_ready "$SOURCE_PROJECT" "$SOURCE_PORT"

echo "Seeding source data..."
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" run --rm --no-deps \
  --entrypoint node app /app/dist/seed-restore-e2e.mjs

echo "Creating baseline backup..."
export COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml"
export COMPOSE_ENV_FILE="$DRILL_ENV"
compose "$SOURCE_PROJECT" exec -T app sh -c 'test -z "${CONFIG_ENCRYPTION_KEY:-}"' || fail "source uses direct CONFIG_ENCRYPTION_KEY"
COMPOSE_PROJECT_NAME=$SOURCE_PROJECT ./scripts/backup.sh "$BACKUP_DIR"
ARCHIVE=$(ls -1t "$BACKUP_DIR"/openlayerly-backup-*.tar.gz | head -n 1)
[ -n "$ARCHIVE" ] || fail "backup archive not found"

echo "Stopping source app before restore target comes online..."
S7_E2E_APP_PORT=$SOURCE_PORT compose "$SOURCE_PROJECT" stop app

echo "Starting isolated restore stack on port ${RESTORE_PORT}..."
S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" up -d postgres
S7_E2E_APP_PORT=$RESTORE_PORT compose "$RESTORE_PROJECT" create app >/dev/null

echo "Running hardened restore into ${RESTORE_PROJECT}..."
S7_E2E_APP_PORT=$RESTORE_PORT \
  COMPOSE_PROJECT_NAME=$RESTORE_PROJECT \
  COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml" \
  COMPOSE_ENV_FILE="$DRILL_ENV" \
  RESTORE_E2E_INJECT_MISSING=1 \
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

echo "S7 restore E2E drill passed."
echo "Archive: $ARCHIVE"
echo "Source project: $SOURCE_PROJECT (port $SOURCE_PORT)"
echo "Restore project: $RESTORE_PROJECT (port $RESTORE_PORT)"