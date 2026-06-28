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

# Returns 0 if the object exists on the given MinIO port, non-zero if absent.
object_exists() {
  oe_port=$1
  oe_key=$2
  sudo -n docker run --rm --network host --entrypoint /bin/sh minio/mc:latest -c "
      mc alias set chk http://127.0.0.1:${oe_port} ${MINIO_USER} ${MINIO_PASSWORD} >/dev/null 2>&1
      mc stat chk/${MINIO_BUCKET}/${oe_key} >/dev/null 2>&1
    "
}

# Poll until an object is gone from MinIO (orphan cleanup actually executed).
wait_object_absent() {
  wa_port=$1
  wa_key=$2
  wa_attempt=0
  while object_exists "$wa_port" "$wa_key"; do
    wa_attempt=$((wa_attempt + 1))
    [ "$wa_attempt" -lt 40 ] || fail "orphan object still present after restore: $wa_key"
    sleep 3
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
SENTINEL_OBJECT_KEY=$(printf '%s' "$SEED_JSON" | node -e 'const input=[];process.stdin.on("data",d=>input.push(d));process.stdin.on("end",()=>{const j=JSON.parse(Buffer.concat(input).toString());process.stdout.write(j.sentinelObjectKey);});')
[ -n "$REFERENCED_OBJECT_KEY" ] && [ -n "$ORPHAN_OBJECT_KEY" ] || fail "S3 seed markers missing object keys"
[ -n "$SENTINEL_OBJECT_KEY" ] || fail "S3 seed marker missing out-of-prefix sentinel key"

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
  RESTORE_CONVERGE_PAGE_SIZE=2 \
  READY_URL="http://127.0.0.1:${RESTORE_PORT}/api/ready" \
  ./scripts/restore.sh "$ARCHIVE" --yes

READY_BODY=$(curl -fsS "http://127.0.0.1:${RESTORE_PORT}/api/ready")
echo "$READY_BODY" | grep -q '"ok":true' || fail "ready body was not ok: $READY_BODY"

QUARANTINE_COUNT=$(
  S7_E2E_APP_PORT=$RESTORE_PORT S7_S3_MINIO_PORT=$RESTORE_MINIO_PORT \
    compose "$RESTORE_PROJECT" exec -T -e REF_ID="$REFERENCED_FILE_ID" postgres sh -c '
    exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
      -c "select count(*) from files where id = '"'"'$REF_ID'"'"' and quarantine_reason = '"'"'missing after restore'"'"';"
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

echo "Verifying out-of-prefix sentinel object was left untouched..."
sudo -n docker run --rm --network host --entrypoint /bin/sh minio/mc:latest -c "
    set -eu
    mc alias set dst http://127.0.0.1:${RESTORE_MINIO_PORT} ${MINIO_USER} ${MINIO_PASSWORD}
    mc stat dst/${MINIO_BUCKET}/${SENTINEL_OBJECT_KEY} >/dev/null
  " || fail "out-of-prefix sentinel object was removed by convergence (prefix boundary violated)"

echo "Verifying both orphan objects were actually deleted from MinIO..."
INJECTED_ORPHAN_KEY="content/restore-s3-e2e/injected-orphan.txt"
wait_object_absent "$RESTORE_MINIO_PORT" "$ORPHAN_OBJECT_KEY"
wait_object_absent "$RESTORE_MINIO_PORT" "$INJECTED_ORPHAN_KEY"
# Prove the delete tasks for exactly those two keys reached 'succeeded' (not merely
# enqueued/pending), so the success path truly converged storage, not just the DB.
for okey in "$ORPHAN_OBJECT_KEY" "$INJECTED_ORPHAN_KEY"; do
  SUCC_COUNT=$(
    S7_E2E_APP_PORT=$RESTORE_PORT S7_S3_MINIO_PORT=$RESTORE_MINIO_PORT \
      compose "$RESTORE_PROJECT" exec -T -e OKEY="$okey" postgres sh -c '
      exec psql -At -U "${POSTGRES_USER:-artist}" -d "${POSTGRES_DB:-artist_member}" \
        -c "select count(*) from tasks where kind = '"'"'storage.delete_object'"'"' and status = '"'"'succeeded'"'"' and payload_json->>'"'"'objectKey'"'"' = '"'"'$OKEY'"'"';"
    '
  )
  [ "$SUCC_COUNT" -ge 1 ] || fail "no succeeded storage.delete_object task for orphan $okey (count=$SUCC_COUNT)"
done

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

echo "Verifying a real S3 listing/auth error fails closed and keeps the app stopped..."
AUTH_FAIL_PROJECT=${RESTORE_PROJECT}_autherr
AUTH_FAIL_OVERRIDE=/tmp/openlayerly-s7-s3-autherr-override.yml
# Override only the app's S3 secret via a compose file (its `environment:` wins over
# both the env_file and the base s3 compose). Convergence/pre-scan then hits a genuine
# ListObjects auth error — not a truncation cap — which must fail the restore before the
# app starts. MinIO keeps its real root credentials, so it is purely a client-auth fault.
cat >"$AUTH_FAIL_OVERRIDE" <<'EOF'
services:
  app:
    environment:
      S3_SECRET_ACCESS_KEY: wrong-secret-deadbeef
EOF
AUTH_FAIL_FILES="docker-compose.yml:docker-compose.s7-e2e.yml:docker-compose.s7-s3-e2e.yml:$AUTH_FAIL_OVERRIDE"
authfail_compose() {
  sudo -n env S7_E2E_APP_PORT=3008 S7_S3_MINIO_PORT=9008 \
    docker compose -p "$AUTH_FAIL_PROJECT" --env-file "$DRILL_ENV" \
    -f docker-compose.yml -f docker-compose.s7-e2e.yml -f docker-compose.s7-s3-e2e.yml \
    -f "$AUTH_FAIL_OVERRIDE" \
    "$@"
}
authfail_compose down -v >/dev/null 2>&1 || true
authfail_compose up -d postgres minio minio-init >/dev/null
authfail_compose create app >/dev/null
mirror_bucket "$SOURCE_MINIO_PORT" 9008
if S7_E2E_APP_PORT=3008 S7_S3_MINIO_PORT=9008 \
  COMPOSE_PROJECT_NAME=$AUTH_FAIL_PROJECT \
  COMPOSE_FILE="$AUTH_FAIL_FILES" \
  COMPOSE_ENV_FILE="$DRILL_ENV" \
  RESTORE_S3_ENUM_PREFIXES="content/" \
  READY_URL="http://127.0.0.1:3008/api/ready" \
  ./scripts/restore.sh "$ARCHIVE" --yes >/tmp/openlayerly-s7-s3-autherr-restore.log 2>&1; then
  fail "restore unexpectedly succeeded with invalid S3 credentials"
fi
if curl -fsS "http://127.0.0.1:3008/api/ready" >/dev/null 2>&1; then
  fail "app became ready after an S3 listing/auth failure"
fi
# The bad S3 secret can surface during pre-scan or convergence depending on which
# step lists first; either way the restore must fail closed before the app starts.
grep -qiE 'pre.?scan|converg|storage|s3|signature|credential|denied|access' \
  /tmp/openlayerly-s7-s3-autherr-restore.log \
  || fail "S3 auth failure did not surface as a storage/convergence error"
authfail_compose down -v >/dev/null 2>&1 || true
rm -f "$AUTH_FAIL_OVERRIDE"

echo "S7 S3 restore E2E drill passed."
echo "Archive: $ARCHIVE"
echo "Referenced object: $REFERENCED_OBJECT_KEY"
echo "Orphan object: $ORPHAN_OBJECT_KEY"