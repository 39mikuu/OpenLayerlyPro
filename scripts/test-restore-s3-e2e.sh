#!/bin/sh
# shellcheck disable=SC2016
set -eu

umask 077

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

SOURCE_PROJECT=${SOURCE_PROJECT:-openlayerlypro_s7_s3_source}
RESTORE_PROJECT=${RESTORE_PROJECT:-openlayerlypro_s7_s3_restore}
SOURCE_PORT=${SOURCE_PORT:-3005}
RESTORE_PORT=${RESTORE_PORT:-3006}
SOURCE_MINIO_PORT=${SOURCE_MINIO_PORT:-9005}
RESTORE_MINIO_PORT=${RESTORE_MINIO_PORT:-9006}
BACKUP_DIR=${BACKUP_DIR:-/tmp/openlayerlypro-s7-s3-e2e-backups}
DRILL_ENV=${DRILL_ENV:-.env.s7-s3-e2e}
MINIO_USER=${MINIO_USER:-s7minioadmin}
MINIO_PASSWORD=${MINIO_PASSWORD:-s7minioadmin-secret-0123}
MINIO_BUCKET=${MINIO_BUCKET:-openlayerly-s7-e2e}

fail() {
  echo "restore-s3-e2e: $*" >&2
  exit 1
}

compose() {
  project=$1
  shift
  sudo -n env \
    S7_E2E_APP_PORT="${S7_E2E_APP_PORT:-3005}" \
    S7_S3_MINIO_PORT="${S7_S3_MINIO_PORT:-9005}" \
    docker compose \
    -p "$project" \
    --env-file "$DRILL_ENV" \
    -f docker-compose.yml \
    -f docker-compose.s7-e2e.yml \
    -f docker-compose.s7-s3-e2e.yml \
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

mirror_bucket() {
  src_port=$1
  dst_port=$2
  sudo -n docker run --rm --network host --entrypoint /bin/sh minio/mc:latest -c "
      set -eu
      mc alias set src http://127.0.0.1:${src_port} ${MINIO_USER} ${MINIO_PASSWORD}
      mc alias set dst http://127.0.0.1:${dst_port} ${MINIO_USER} ${MINIO_PASSWORD}
      mc mb --ignore-existing dst/${MINIO_BUCKET}
      mc mirror --overwrite src/${MINIO_BUCKET} dst/${MINIO_BUCKET}
    "
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

if [ ! -f "$DRILL_ENV" ]; then
  cat >"$DRILL_ENV" <<'EOF'
APP_URL=http://127.0.0.1:3005
APP_NAME=OpenLayerlyPro S7 S3 Restore Drill
NODE_ENV=production
SESSION_SECRET=s7-restore-s3-e2e-session-secret-012345
SECURITY_CSP_MODE=auto
SECURITY_HSTS_ENABLED=false
CONFIG_ENCRYPTION_KEY=
CONFIG_ENCRYPTION_KEY_FILE=/app/secrets/config-encryption-key
DATABASE_URL=postgresql://artist:artist_password@postgres:5432/artist_member
STORAGE_DRIVER=s3
S3_ENDPOINT=http://minio:9000
S3_REGION=auto
S3_BUCKET=openlayerly-s7-e2e
S3_ACCESS_KEY_ID=s7minioadmin
S3_SECRET_ACCESS_KEY=s7minioadmin-secret-0123
S3_FORCE_PATH_STYLE=true
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

echo "Cleaning previous S3 drill projects..."
for project in "$SOURCE_PROJECT" "$RESTORE_PROJECT"; do
  sudo -n env \
    S7_E2E_APP_PORT="${S7_E2E_APP_PORT:-3005}" \
    S7_S3_MINIO_PORT="${S7_S3_MINIO_PORT:-9005}" \
    docker compose -p "$project" --env-file "$DRILL_ENV" \
    -f docker-compose.yml -f docker-compose.s7-e2e.yml -f docker-compose.s7-s3-e2e.yml \
    down -v >/dev/null 2>&1 || true
done

echo "Building source image..."
S7_E2E_APP_PORT=$SOURCE_PORT S7_S3_MINIO_PORT=$SOURCE_MINIO_PORT \
  compose "$SOURCE_PROJECT" build app
sudo -n docker image inspect "${SOURCE_PROJECT}-app:latest" >/dev/null 2>&1 \
  || fail "source app image was not built"
sudo -n docker tag "${SOURCE_PROJECT}-app:latest" "${RESTORE_PROJECT}-app:latest"

echo "Starting source S3 stack on port ${SOURCE_PORT}..."
S7_E2E_APP_PORT=$SOURCE_PORT S7_S3_MINIO_PORT=$SOURCE_MINIO_PORT \
  compose "$SOURCE_PROJECT" up -d postgres minio minio-init
S7_E2E_APP_PORT=$SOURCE_PORT S7_S3_MINIO_PORT=$SOURCE_MINIO_PORT \
  compose "$SOURCE_PROJECT" up -d app
wait_ready "$SOURCE_PROJECT" "$SOURCE_PORT"

echo "Seeding source S3 data..."
SEED_JSON=$(
  S7_E2E_APP_PORT=$SOURCE_PORT S7_S3_MINIO_PORT=$SOURCE_MINIO_PORT \
    compose "$SOURCE_PROJECT" run --rm --no-deps \
    --entrypoint node app /app/dist/seed-restore-s3-e2e.mjs | awk '/^\{/,/^}/'
)
[ -n "$SEED_JSON" ] || fail "S3 seed output missing JSON markers"
REFERENCED_OBJECT_KEY=$(printf '%s' "$SEED_JSON" | node -e 'const input=[];process.stdin.on("data",d=>input.push(d));process.stdin.on("end",()=>{const j=JSON.parse(Buffer.concat(input).toString());process.stdout.write(j.referencedObjectKey);});')
ORPHAN_OBJECT_KEY=$(printf '%s' "$SEED_JSON" | node -e 'const input=[];process.stdin.on("data",d=>input.push(d));process.stdin.on("end",()=>{const j=JSON.parse(Buffer.concat(input).toString());process.stdout.write(j.orphanObjectKey);});')
REFERENCED_FILE_ID=$(printf '%s' "$SEED_JSON" | node -e 'const input=[];process.stdin.on("data",d=>input.push(d));process.stdin.on("end",()=>{const j=JSON.parse(Buffer.concat(input).toString());process.stdout.write(j.referencedFileId);});')
[ -n "$REFERENCED_OBJECT_KEY" ] && [ -n "$ORPHAN_OBJECT_KEY" ] || fail "S3 seed markers missing object keys"

echo "Creating S3 baseline backup..."
export COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml:docker-compose.s7-s3-e2e.yml"
export COMPOSE_ENV_FILE="$DRILL_ENV"
COMPOSE_PROJECT_NAME=$SOURCE_PROJECT S7_E2E_APP_PORT=$SOURCE_PORT S7_S3_MINIO_PORT=$SOURCE_MINIO_PORT \
  ./scripts/backup.sh "$BACKUP_DIR"
ARCHIVE=$(ls -1t "$BACKUP_DIR"/openlayerly-backup-*.tar.gz | head -n 1)
[ -n "$ARCHIVE" ] || fail "backup archive not found"
tar -tzf "$ARCHIVE" | grep -q 'UPLOADS_SKIPPED_S3' || fail "S3 backup missing UPLOADS_SKIPPED_S3 marker"

echo "Stopping source app before restore target comes online..."
S7_E2E_APP_PORT=$SOURCE_PORT S7_S3_MINIO_PORT=$SOURCE_MINIO_PORT \
  compose "$SOURCE_PROJECT" stop app

echo "Starting isolated restore S3 stack on port ${RESTORE_PORT}..."
S7_E2E_APP_PORT=$RESTORE_PORT S7_S3_MINIO_PORT=$RESTORE_MINIO_PORT \
  compose "$RESTORE_PROJECT" up -d postgres minio minio-init
S7_E2E_APP_PORT=$RESTORE_PORT S7_S3_MINIO_PORT=$RESTORE_MINIO_PORT \
  compose "$RESTORE_PROJECT" create app >/dev/null

echo "Mirroring bucket snapshot from source MinIO (${SOURCE_MINIO_PORT}) to target (${RESTORE_MINIO_PORT})..."
mirror_bucket "$SOURCE_MINIO_PORT" "$RESTORE_MINIO_PORT"

echo "Running hardened S3 restore into ${RESTORE_PROJECT}..."
S7_E2E_APP_PORT=$RESTORE_PORT S7_S3_MINIO_PORT=$RESTORE_MINIO_PORT \
  COMPOSE_PROJECT_NAME=$RESTORE_PROJECT \
  COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml:docker-compose.s7-s3-e2e.yml" \
  COMPOSE_ENV_FILE="$DRILL_ENV" \
  RESTORE_E2E_INJECT_MISSING=1 \
  RESTORE_E2E_MISSING_OBJECT_KEY="$REFERENCED_OBJECT_KEY" \
  RESTORE_E2E_ORPHAN_OBJECT_KEY="content/restore-s3-e2e/injected-orphan.txt" \
  RESTORE_S3_ENUM_PREFIXES="content/" \
  READY_URL="http://127.0.0.1:${RESTORE_PORT}/api/ready" \
  ./scripts/restore.sh "$ARCHIVE" --yes

READY_BODY=$(curl -fsS "http://127.0.0.1:${RESTORE_PORT}/api/ready")
echo "$READY_BODY" | grep -q '"ok":true' || fail "ready body was not ok: $READY_BODY"

QUARANTINE_COUNT=$(
  S7_E2E_APP_PORT=$RESTORE_PORT S7_S3_MINIO_PORT=$RESTORE_MINIO_PORT \
    compose "$RESTORE_PROJECT" exec -T -e REF_ID="$REFERENCED_FILE_ID" postgres sh -c '
    exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
      -v ref_id="$REF_ID" \
      -c "select count(*) from files where id = :'"'"'ref_id'"'"' and quarantine_reason = '"'"'missing after restore'"'"';"
  '
)
[ "$QUARANTINE_COUNT" = "1" ] || fail "referenced S3 file was not quarantined (count=$QUARANTINE_COUNT)"

DELETE_TASK_COUNT=$(
  S7_E2E_APP_PORT=$RESTORE_PORT S7_S3_MINIO_PORT=$RESTORE_MINIO_PORT \
    compose "$RESTORE_PROJECT" exec -T postgres sh -c '
    exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
      -c "select count(*) from tasks where kind = '"'"'storage.delete_object'"'"' and status in ('"'"'pending'"'"', '"'"'processing'"'"', '"'"'succeeded'"'"');"
  '
)
[ "$DELETE_TASK_COUNT" -ge 2 ] || fail "expected orphan cleanup delete tasks (count=$DELETE_TASK_COUNT)"

echo "Verifying converge truncation prevents app startup..."
FAIL_PROJECT=${RESTORE_PROJECT}_fail
sudo -n env S7_E2E_APP_PORT=3007 S7_S3_MINIO_PORT=9007 \
  docker compose -p "$FAIL_PROJECT" --env-file "$DRILL_ENV" \
  -f docker-compose.yml -f docker-compose.s7-e2e.yml -f docker-compose.s7-s3-e2e.yml \
  down -v >/dev/null 2>&1 || true
sudo -n env S7_E2E_APP_PORT=3007 S7_S3_MINIO_PORT=9007 \
  docker compose -p "$FAIL_PROJECT" --env-file "$DRILL_ENV" \
  -f docker-compose.yml -f docker-compose.s7-e2e.yml -f docker-compose.s7-s3-e2e.yml \
  up -d postgres minio minio-init >/dev/null
sudo -n env S7_E2E_APP_PORT=3007 S7_S3_MINIO_PORT=9007 \
  docker compose -p "$FAIL_PROJECT" --env-file "$DRILL_ENV" \
  -f docker-compose.yml -f docker-compose.s7-e2e.yml -f docker-compose.s7-s3-e2e.yml \
  create app >/dev/null
mirror_bucket "$SOURCE_MINIO_PORT" 9007
if S7_E2E_APP_PORT=3007 S7_S3_MINIO_PORT=9007 \
  COMPOSE_PROJECT_NAME=$FAIL_PROJECT \
  COMPOSE_FILE="docker-compose.yml:docker-compose.s7-e2e.yml:docker-compose.s7-s3-e2e.yml" \
  COMPOSE_ENV_FILE="$DRILL_ENV" \
  RESTORE_CONVERGE_MAX_OBJECTS=1 \
  RESTORE_S3_ENUM_PREFIXES="content/" \
  READY_URL="http://127.0.0.1:3007/api/ready" \
  ./scripts/restore.sh "$ARCHIVE" --yes >/tmp/openlayerly-s7-s3-fail-restore.log 2>&1; then
  fail "truncated converge restore unexpectedly succeeded"
fi
if curl -fsS "http://127.0.0.1:3007/api/ready" >/dev/null 2>&1; then
  fail "app became ready after truncated converge failure"
fi
grep -q 'restore convergence failed' /tmp/openlayerly-s7-s3-fail-restore.log \
  || fail "truncated converge did not emit expected failure message"

echo "S7 S3 restore E2E drill passed."
echo "Archive: $ARCHIVE"
echo "Referenced object: $REFERENCED_OBJECT_KEY"
echo "Orphan object: $ORPHAN_OBJECT_KEY"