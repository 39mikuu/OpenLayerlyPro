#!/bin/sh
# shellcheck disable=SC2016 # Positional parameters intentionally expand in the child shell.
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/openlayerly-restore-shell-args.XXXXXX")
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

fail() {
  echo "restore-shell-args-test: $*" >&2
  exit 1
}

VALID_COMMIT=0123456789abcdef0123456789abcdef01234567
VALID_TOOL_COMMIT=abcdef0123456789abcdef0123456789abcdef01
VALID_IMAGE_ID=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
VALID_TOOL_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
DOCKER_INSPECT_ENV_JSON='["APP_VERSION=image-version","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567","BUILD_TIMESTAMP=2026-07-05T00:00:00Z"]'
DOCKER_IMAGE_ENV_JSON='["APP_VERSION=image-version","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567","BUILD_TIMESTAMP=2026-07-05T00:00:00Z"]'
DOCKER_INSPECT_CONTAINER_IMAGE_JSON='"sha256:mock-container-image"'
DOCKER_INSPECT_RUNNING_JSON=true
DOCKER_IMAGE_LABELS_JSON='{"org.opencontainers.image.version":"image-version","org.opencontainers.image.revision":"0123456789abcdef0123456789abcdef01234567","org.opencontainers.image.created":"2026-07-05T00:00:00Z"}'
DOCKER_IMAGE_ID_JSON='"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
COMPOSE_IMAGE_LABELS_JSON='{"org.opencontainers.image.version":"compose-config-version","org.opencontainers.image.revision":"fedcba9876543210fedcba9876543210fedcba98","org.opencontainers.image.created":"2026-07-06T00:00:00Z"}'
COMPOSE_IMAGE_ENV_JSON='["APP_VERSION=compose-config-version","SOURCE_COMMIT=fedcba9876543210fedcba9876543210fedcba98","BUILD_TIMESTAMP=2026-07-06T00:00:00Z"]'
COMPOSE_IMAGE_ID_JSON='"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"'
COMPOSE_PS_APP_OUTPUT=mock-app-container
COMPOSE_PS_FAIL=false
COMPOSE_APP_IMAGE=openlayerlypro:test
COMPOSE_CREATE_RESULT=mock-app-container
COMPOSE_MUTATION_LOG="$TEST_ROOT/compose-mutations.log"

docker_cmd() {
  action=$1
  shift
  case "$action" in
    image)
      [ "$1" = "inspect" ] || fail "unexpected mock docker image action: $1"
      shift
      image_inspect_format=""
      image_inspect_target=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --format)
            image_inspect_format=$2
            shift 2
            ;;
          *)
            [ "$1" = "sha256:mock-container-image" ] || [ "$1" = "$COMPOSE_APP_IMAGE" ] \
              || fail "mock docker image inspect received unexpected image ref: $1"
            image_inspect_target=$1
            shift
            ;;
        esac
      done
      [ -n "$image_inspect_target" ] || fail "mock docker image inspect missing target"
      case "$image_inspect_format" in
        "{{json .Config.Labels}} {{json .Id}}")
          if [ "$image_inspect_target" = "$COMPOSE_APP_IMAGE" ]; then
            printf '%s %s\n' "$COMPOSE_IMAGE_LABELS_JSON" "$COMPOSE_IMAGE_ID_JSON"
          else
            printf '%s %s\n' "$DOCKER_IMAGE_LABELS_JSON" "$DOCKER_IMAGE_ID_JSON"
          fi
          ;;
        "{{json .Config.Env}}")
          if [ "$image_inspect_target" = "$COMPOSE_APP_IMAGE" ]; then
            printf '%s\n' "$COMPOSE_IMAGE_ENV_JSON"
          else
            printf '%s\n' "$DOCKER_IMAGE_ENV_JSON"
          fi
          ;;
        *)
          fail "unexpected mock docker image inspect format: $image_inspect_format"
          ;;
      esac
      ;;
    inspect)
      format_seen=false
      inspect_target=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --format)
            format_seen=true
            inspect_format=$2
            shift 2
            ;;
          *)
            [ "$1" = "mock-app-container" ] || fail "mock docker inspect received unexpected container id: $1"
            inspect_target=$1
            shift
            ;;
        esac
      done
      [ "$format_seen" = true ] || fail "mock docker inspect missing --format"
      [ "$inspect_target" = "mock-app-container" ] || fail "mock docker inspect missing target"
      case "$inspect_format" in
        "{{json .Image}}")
          printf '%s\n' "$DOCKER_INSPECT_CONTAINER_IMAGE_JSON"
          ;;
        "{{json .Config.Env}}")
          printf '%s\n' "$DOCKER_INSPECT_ENV_JSON"
          ;;
        "{{json .State.Running}}")
          printf '%s\n' "$DOCKER_INSPECT_RUNNING_JSON"
          ;;
        *)
          fail "unexpected mock docker inspect format: $inspect_format"
          ;;
      esac
      ;;
    *)
      fail "unexpected mock docker action: $action"
      ;;
  esac
}

# Execute the container shell argv locally. This preserves the sh -c boundary:
# the command text is one argument, the fixed argv[0] sentinel is next, and all
# dynamic values follow as positional parameters.
compose() {
  action=$1
  shift
  case "$action" in
    create)
      printf '%s\n' "create app" >> "$COMPOSE_MUTATION_LOG"
      [ "$1" = "app" ] || fail "mock compose create did not receive app service"
      COMPOSE_PS_APP_OUTPUT=$COMPOSE_CREATE_RESULT
      return
      ;;
    ps)
      if [ "$COMPOSE_PS_FAIL" = true ]; then
        return 1
      fi
      [ "$1" = "-aq" ] || fail "mock compose ps expected -aq"
      [ "$2" = "app" ] || fail "mock compose ps did not receive app service"
      printf '%s\n' "$COMPOSE_PS_APP_OUTPUT"
      return
      ;;
    config)
      [ "$1" = "--images" ] || fail "mock compose config expected --images"
      [ "$2" = "app" ] || fail "mock compose config did not receive app service"
      printf '%s\n' "$COMPOSE_APP_IMAGE"
      return
      ;;
    up|run)
      printf '%s\n' "$action $*" >> "$COMPOSE_MUTATION_LOG"
      if [ "$action" = "up" ]; then
        return
      fi
      while [ "$#" -gt 0 ] && [ "$1" != "app" ]; do
        shift
      done
      [ "$#" -gt 0 ] || fail "mock compose run did not receive app service"
      shift
      command sh "$@"
      return
      ;;
    exec)
      while [ "$#" -gt 0 ] && [ "$1" != "postgres" ]; do
        shift
      done
      [ "$#" -gt 0 ] || fail "mock compose exec did not receive postgres service"
      shift
      ;;
    *)
      fail "unexpected mock compose action: $action"
      ;;
  esac
  [ "$1" = "sh" ] || fail "mock compose expected sh entrypoint"
  shift
  command sh "$@"
}

# shellcheck source=scripts/restore-common.sh disable=SC1091
. "$ROOT_DIR/scripts/restore-common.sh"

cd "$TEST_ROOT"
INJECTION_MARKER="$TEST_ROOT/INJECTED"
SINGLE_QUOTE="'"
DOUBLE_QUOTE='"'
DOLLAR='$'
SPECIAL_COMPONENT="space ${SINGLE_QUOTE}single${SINGLE_QUOTE} ${DOUBLE_QUOTE}double${DOUBLE_QUOTE} ${DOLLAR}dollar ; ${DOLLAR}(touch INJECTED) [*]"
SPECIAL_DIR="$TEST_ROOT/$SPECIAL_COMPONENT"
SPECIAL_FILE="$SPECIAL_DIR/key $SPECIAL_COMPONENT"
SPECIAL_OBJECT="nested/proof ${SPECIAL_COMPONENT}.txt"

mkdir -p "$SPECIAL_DIR"
canonical=$(canonicalize_container_path "$SPECIAL_DIR" "special path")
[ "$canonical" = "$SPECIAL_DIR" ] || fail "canonical path changed shell-sensitive characters"
[ ! -e "$INJECTION_MARKER" ] || fail "canonicalization executed injected shell text"

preflight_volume_write_read_delete "$SPECIAL_DIR" "special path"
[ ! -e "$INJECTION_MARKER" ] || fail "preflight executed injected shell text"
[ -z "$(find "$SPECIAL_DIR" -name '.restore-preflight.*' -print -quit)" ] \
  || fail "preflight did not remove its sentinel"

printf '%s' "key-material" > "$SPECIAL_FILE"
verify_container_nonempty_file "$SPECIAL_FILE"
[ ! -e "$INJECTION_MARKER" ] || fail "file verification executed injected shell text"

mkdir -p "$SPECIAL_DIR/nested"
printf '%s' "proof" > "$SPECIAL_DIR/$SPECIAL_OBJECT"
remove_container_object "$SPECIAL_DIR" "$SPECIAL_OBJECT"
[ ! -e "$SPECIAL_DIR/$SPECIAL_OBJECT" ] || fail "object removal did not remove the exact path"
[ ! -e "$INJECTION_MARKER" ] || fail "object removal executed injected shell text"

TEXT_FILE="$SPECIAL_DIR/first ${SPECIAL_COMPONENT}.txt"
printf '%s' "text" > "$TEXT_FILE"
remove_first_container_text_file "$SPECIAL_DIR"
[ ! -e "$TEXT_FILE" ] || fail "text-file removal did not remove the selected path"
[ ! -e "$INJECTION_MARKER" ] || fail "text-file removal executed injected shell text"

printf '%s' "visible" > "$SPECIAL_DIR/visible"
printf '%s' "hidden" > "$SPECIAL_DIR/.hidden"
mkdir -p "$SPECIAL_DIR/subdir"
printf '%s' "nested" > "$SPECIAL_DIR/subdir/nested"
clear_container_directory "$SPECIAL_DIR"
[ -d "$SPECIAL_DIR" ] || fail "directory clear removed the target directory"
[ -z "$(find "$SPECIAL_DIR" -mindepth 1 -print -quit)" ] \
  || fail "directory clear left entries behind"
[ ! -e "$INJECTION_MARKER" ] || fail "directory clear executed injected shell text"

round_trip=$(run_app_shell 'printf "%s" "$1"' "$SPECIAL_COMPONENT")
[ "$round_trip" = "$SPECIAL_COMPONENT" ] || fail "app positional argument did not round-trip"
round_trip=$(run_postgres_shell 'printf "%s" "$1"' "$SPECIAL_COMPONENT")
[ "$round_trip" = "$SPECIAL_COMPONENT" ] || fail "postgres positional argument did not round-trip"
[ ! -e "$INJECTION_MARKER" ] || fail "shell wrapper executed injected shell text"

: > "$COMPOSE_MUTATION_LOG"
single_container_id=$(resolve_single_app_container_id)
[ "$single_container_id" = "mock-app-container" ] \
  || fail "single app container id did not resolve from compose ps"
if grep -E '^(create|up|run) ' "$COMPOSE_MUTATION_LOG" >/dev/null; then
  fail "existing app container resolution mutated compose state"
fi
read_app_container_provenance "$single_container_id"
[ "$RUNTIME_APP_VERSION" = "image-version" ] \
  || fail "inspected app version was not read from existing container image labels"
[ "$RUNTIME_SOURCE_COMMIT" = "$VALID_COMMIT" ] \
  || fail "inspected source commit was not read from image labels"
[ "$BUILD_TIMESTAMP" = "2026-07-05T00:00:00Z" ] \
  || fail "inspected build timestamp was not read from image labels"
[ "$RUNTIME_IMAGE_ID" = "$VALID_IMAGE_ID" ] \
  || fail "inspected image ID was not read from the existing container image"

: > "$COMPOSE_MUTATION_LOG"
COMPOSE_PS_APP_OUTPUT=""
zero_container_id=$(resolve_single_app_container_id)
[ "$zero_container_id" = "$COMPOSE_CREATE_RESULT" ] \
  || fail "zero-container app resolution did not create and resolve the app container"
create_count=$(grep -c '^create app$' "$COMPOSE_MUTATION_LOG" || true)
[ "$create_count" = "1" ] \
  || fail "zero-container app resolution did not call compose create exactly once"
read_app_container_provenance "$zero_container_id"
[ "$RUNTIME_APP_VERSION" = "image-version" ] \
  || fail "zero-container provenance was not read from the created container's image"
[ "$RUNTIME_IMAGE_ID" = "$VALID_IMAGE_ID" ] \
  || fail "zero-container image ID was not read from the created container's image"
COMPOSE_PS_APP_OUTPUT=mock-app-container

: > "$COMPOSE_MUTATION_LOG"
COMPOSE_PS_FAIL=true
set +e
compose_ps_failure_output=$(resolve_single_app_container_id 2>&1)
compose_ps_failure_status=$?
set -e
COMPOSE_PS_FAIL=false
[ "$compose_ps_failure_status" -ne 0 ] \
  || fail "compose ps failure unexpectedly degraded to create path"
printf '%s' "$compose_ps_failure_output" \
  | grep -F "unable to list app service containers for image provenance" >/dev/null \
  || fail "compose ps failure error was not explicit"
if grep -E '^(create|up|run) ' "$COMPOSE_MUTATION_LOG" >/dev/null; then
  fail "compose ps failure mutated compose state"
fi

DOCKER_INSPECT_ENV_JSON='["APP_VERSION=stale-env-version","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567","BUILD_TIMESTAMP=2026-07-05T00:00:00Z"]'
set +e
env_override_output=$(read_app_container_provenance "$single_container_id" 2>&1)
env_override_status=$?
set -e
[ "$env_override_status" -ne 0 ] \
  || fail "container env overriding image labels unexpectedly passed"
printf '%s' "$env_override_output" \
  | grep -F "container environment overrides the image build identity" >/dev/null \
  || fail "env-vs-label mismatch error was not explicit"

DOCKER_INSPECT_ENV_JSON='["APP_VERSION=","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567","BUILD_TIMESTAMP=2026-07-05T00:00:00Z"]'
set +e
empty_override_output=$(read_app_container_provenance "$single_container_id" 2>&1)
empty_override_status=$?
set -e
[ "$empty_override_status" -ne 0 ] \
  || fail "container env empty-string override unexpectedly passed"
printf '%s' "$empty_override_output" \
  | grep -F "container environment overrides the image build identity" >/dev/null \
  || fail "empty-string env override error was not explicit"

DOCKER_INSPECT_ENV_JSON='["APP_VERSION=image-version","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567"]'
set +e
unset_override_output=$(read_app_container_provenance "$single_container_id" 2>&1)
unset_override_status=$?
set -e
[ "$unset_override_status" -ne 0 ] \
  || fail "container env unsetting an image build variable unexpectedly passed"
printf '%s' "$unset_override_output" \
  | grep -F "container environment overrides the image build identity" >/dev/null \
  || fail "unset env override error was not explicit"

DOCKER_INSPECT_ENV_JSON='["APP_VERSION=image-version","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567","BUILD_TIMESTAMP=2026-07-05T00:00:00Z"]'

COMPOSE_IMAGE_ENV_JSON='["APP_VERSION=image-version","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567","BUILD_TIMESTAMP=2026-07-05T00:00:00Z","STORAGE_DRIVER=s3","UPLOAD_DIR=/app/uploads/compose-config"]'
DOCKER_INSPECT_ENV_JSON='["APP_VERSION=image-version","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567","BUILD_TIMESTAMP=2026-07-05T00:00:00Z","CONFIG_ENCRYPTION_KEY=","CONFIG_ENCRYPTION_KEY_FILE=/app/secrets/config-encryption-key","SESSION_SECRET=","SESSION_SECRET_FILE=/app/secrets/session-secret","STORAGE_DRIVER=local","UPLOAD_DIR=/app/uploads/container-env"]'
read_app_container_runtime_config "$single_container_id"
[ "$STORAGE_DRIVER" = "local" ] \
  || fail "backup runtime config did not read STORAGE_DRIVER from the app container env"
[ "$UPLOAD_DIR" = "/app/uploads/container-env" ] \
  || fail "backup runtime config did not read UPLOAD_DIR from the app container env"
[ "$UPLOADS_INCLUDED" = true ] \
  || fail "backup runtime config did not include uploads for container-local storage"
[ "$SESSION_SECRET_SOURCE" = file ] \
  || fail "empty SESSION_SECRET in container env did not resolve to file-backed source"
DOCKER_INSPECT_ENV_JSON='["APP_VERSION=image-version","SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567","BUILD_TIMESTAMP=2026-07-05T00:00:00Z"]'
COMPOSE_IMAGE_ENV_JSON='["APP_VERSION=compose-config-version","SOURCE_COMMIT=fedcba9876543210fedcba9876543210fedcba98","BUILD_TIMESTAMP=2026-07-06T00:00:00Z"]'

blank_env_json='["SESSION_SECRET_FILE=","CONFIG_ENCRYPTION_KEY_FILE=","STORAGE_DRIVER=","UPLOAD_DIR="]'
[ "$(container_env_value "$blank_env_json" SESSION_SECRET_FILE /app/secrets/session-secret)" = "/app/secrets/session-secret" ] \
  || fail "blank SESSION_SECRET_FILE env did not fall back to the default path"
[ "$(container_env_value "$blank_env_json" CONFIG_ENCRYPTION_KEY_FILE /app/secrets/config-encryption-key)" = "/app/secrets/config-encryption-key" ] \
  || fail "blank CONFIG_ENCRYPTION_KEY_FILE env did not fall back to the default path"
[ "$(container_env_value "$blank_env_json" STORAGE_DRIVER local)" = "local" ] \
  || fail "blank STORAGE_DRIVER env did not fall back to local"
[ "$(container_env_value "$blank_env_json" UPLOAD_DIR /app/uploads)" = "/app/uploads" ] \
  || fail "blank UPLOAD_DIR env did not fall back to the default path"

verify_app_container_unchanged_for_backup "$single_container_id" "$VALID_IMAGE_ID" \
  || fail "backup container identity guard rejected unchanged container"

COMPOSE_PS_APP_OUTPUT=changed-container
set +e
backup_changed_id_output=$(verify_app_container_unchanged_for_backup "$single_container_id" "$VALID_IMAGE_ID" 2>&1)
backup_changed_id_status=$?
set -e
COMPOSE_PS_APP_OUTPUT=mock-app-container
[ "$backup_changed_id_status" -ne 0 ] \
  || fail "backup container identity guard accepted a changed container id"
printf '%s' "$backup_changed_id_output" \
  | grep -F "app service container changed during backup" >/dev/null \
  || fail "backup changed-container-id error was not explicit"

DOCKER_IMAGE_ID_JSON='"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"'
set +e
backup_changed_image_output=$(verify_app_container_unchanged_for_backup "$single_container_id" "$VALID_IMAGE_ID" 2>&1)
backup_changed_image_status=$?
set -e
DOCKER_IMAGE_ID_JSON='"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
[ "$backup_changed_image_status" -ne 0 ] \
  || fail "backup container identity guard accepted a changed image id"
printf '%s' "$backup_changed_image_output" \
  | grep -F "app service container changed during backup" >/dev/null \
  || fail "backup changed-image-id error was not explicit"

COMPOSE_PS_APP_OUTPUT='first-container
second-container'
set +e
multiple_container_output=$(resolve_single_app_container_id 2>&1)
multiple_container_status=$?
set -e
[ "$multiple_container_status" -ne 0 ] \
  || fail "multiple app service containers unexpectedly passed provenance resolution"
printf '%s' "$multiple_container_output" \
  | grep -F "multiple app service containers found; remove stale containers or scale to 1 before backup/restore" >/dev/null \
  || fail "multiple app service containers error was not explicit"
COMPOSE_PS_APP_OUTPUT=mock-app-container

V3_DIR="$TEST_ROOT/v3-archive"
mkdir -p "$V3_DIR/secrets"
printf '  config-key-material  \n' > "$V3_DIR/secrets/config-encryption-key"
CONFIG_KEY_SHA256=$(sha256_trimmed_file "$V3_DIR/secrets/config-encryption-key")
CONFIG_KEY_FORMAT=$(config_encryption_key_format_from_file "$V3_DIR/secrets/config-encryption-key")
cat > "$V3_DIR/manifest.env" <<EOF
FORMAT_VERSION=3
APP_VERSION=host-checkout-version
RUNTIME_APP_VERSION=image-version
RUNTIME_SOURCE_COMMIT=$VALID_COMMIT
RUNTIME_IMAGE_ID=$VALID_IMAGE_ID
BUILD_TIMESTAMP=2026-07-05T00:00:00Z
BACKUP_TOOL_COMMIT=$VALID_TOOL_COMMIT
BACKUP_TOOL_SCRIPT_SHA256=$VALID_TOOL_SHA
CONFIG_ENCRYPTION_KEY_SHA256=$CONFIG_KEY_SHA256
CONFIG_ENCRYPTION_KEY_FORMAT=$CONFIG_KEY_FORMAT
EOF

validate_v3_manifest_file "$V3_DIR/manifest.env" >/dev/null \
  || fail "valid v3 manifest did not pass shared validator"
validate_v3_manifest_file "$V3_DIR/manifest.env" backup >/dev/null \
  || fail "valid backup-side v3 manifest did not pass shared validator"
read_archive_provenance "$V3_DIR/manifest.env" 3
[ "$ARCHIVE_RUNTIME_APP_VERSION" = "image-version" ] \
  || fail "v3 provenance did not prefer runtime image app version"
[ "$ARCHIVE_RUNTIME_SOURCE_COMMIT" = "$VALID_COMMIT" ] \
  || fail "v3 provenance did not parse runtime source commit"
[ "$ARCHIVE_RUNTIME_IMAGE_ID" = "$VALID_IMAGE_ID" ] \
  || fail "v3 provenance did not parse runtime image ID"
[ "$ARCHIVE_BUILD_TIMESTAMP" = "2026-07-05T00:00:00Z" ] \
  || fail "v3 provenance did not parse build timestamp"
[ "$ARCHIVE_BACKUP_TOOL_COMMIT" = "$VALID_TOOL_COMMIT" ] \
  || fail "v3 provenance did not parse backup tool commit"
[ "$ARCHIVE_BACKUP_TOOL_SCRIPT_SHA256" = "$VALID_TOOL_SHA" ] \
  || fail "v3 provenance did not parse backup tool script hash"
[ "$ARCHIVE_CONFIG_ENCRYPTION_KEY_FORMAT" = "legacy" ] \
  || fail "v3 provenance did not parse config encryption key format"
verify_archive_config_key_fingerprint "$V3_DIR" 3 \
  || fail "v3 config encryption key fingerprint did not match trimmed key material"

V3_DEV_DIR="$TEST_ROOT/v3-dev-archive"
mkdir -p "$V3_DEV_DIR"
cat > "$V3_DEV_DIR/manifest.env" <<EOF
FORMAT_VERSION=3
RUNTIME_APP_VERSION=dev
RUNTIME_SOURCE_COMMIT=dev
RUNTIME_IMAGE_ID=$VALID_IMAGE_ID
BUILD_TIMESTAMP=unknown
BACKUP_TOOL_COMMIT=dev
BACKUP_TOOL_SCRIPT_SHA256=$VALID_TOOL_SHA
CONFIG_ENCRYPTION_KEY_SHA256=$CONFIG_KEY_SHA256
CONFIG_ENCRYPTION_KEY_FORMAT=legacy
EOF
read_archive_provenance "$V3_DEV_DIR/manifest.env" 3
[ "$ARCHIVE_RUNTIME_APP_VERSION" = "dev" ] \
  || fail "valid dev-build v3 app version did not parse"
[ "$ARCHIVE_RUNTIME_SOURCE_COMMIT" = "dev" ] \
  || fail "valid dev-build v3 runtime commit did not parse"
[ "$ARCHIVE_BUILD_TIMESTAMP" = "unknown" ] \
  || fail "valid dev-build v3 unknown build timestamp did not parse"

V3_BAD_DIR="$TEST_ROOT/v3-bad-archive"
mkdir -p "$V3_BAD_DIR/secrets"
cp "$V3_DIR/secrets/config-encryption-key" "$V3_BAD_DIR/secrets/config-encryption-key"
sed "s/^CONFIG_ENCRYPTION_KEY_SHA256=.*/CONFIG_ENCRYPTION_KEY_SHA256=0000000000000000000000000000000000000000000000000000000000000000/" \
  "$V3_DIR/manifest.env" > "$V3_BAD_DIR/manifest.env"
set +e
fingerprint_mismatch_output=$(verify_archive_config_key_fingerprint "$V3_BAD_DIR" 3 2>&1)
fingerprint_mismatch_status=$?
set -e
[ "$fingerprint_mismatch_status" -ne 0 ] \
  || fail "v3 config encryption key fingerprint mismatch unexpectedly passed"
printf '%s' "$fingerprint_mismatch_output" \
  | grep -F "does not match manifest CONFIG_ENCRYPTION_KEY_SHA256" >/dev/null \
  || fail "v3 fingerprint mismatch error was not explicit"

V3_V1_DIR="$TEST_ROOT/v3-v1-archive"
mkdir -p "$V3_V1_DIR/secrets"
printf '  cek1:v1-key-material  \n' > "$V3_V1_DIR/secrets/config-encryption-key"
V1_CONFIG_KEY_SHA256=$(sha256_trimmed_file "$V3_V1_DIR/secrets/config-encryption-key")
sed \
  -e "s/^CONFIG_ENCRYPTION_KEY_SHA256=.*/CONFIG_ENCRYPTION_KEY_SHA256=$V1_CONFIG_KEY_SHA256/" \
  -e 's/^CONFIG_ENCRYPTION_KEY_FORMAT=.*/CONFIG_ENCRYPTION_KEY_FORMAT=v1/' \
  "$V3_DIR/manifest.env" > "$V3_V1_DIR/manifest.env"
verify_archive_config_key_fingerprint "$V3_V1_DIR" 3 \
  || fail "v3 v1 config encryption key format did not match cek1 key material"

V3_FORMAT_BAD_DIR="$TEST_ROOT/v3-format-bad-archive"
mkdir -p "$V3_FORMAT_BAD_DIR/secrets"
cp "$V3_DIR/secrets/config-encryption-key" "$V3_FORMAT_BAD_DIR/secrets/config-encryption-key"
sed 's/^CONFIG_ENCRYPTION_KEY_FORMAT=.*/CONFIG_ENCRYPTION_KEY_FORMAT=v1/' \
  "$V3_DIR/manifest.env" > "$V3_FORMAT_BAD_DIR/manifest.env"
set +e
format_mismatch_output=$(verify_archive_config_key_fingerprint "$V3_FORMAT_BAD_DIR" 3 2>&1)
format_mismatch_status=$?
set -e
[ "$format_mismatch_status" -ne 0 ] \
  || fail "v3 config encryption key format mismatch unexpectedly passed"
printf '%s' "$format_mismatch_output" \
  | grep -F "does not match manifest CONFIG_ENCRYPTION_KEY_FORMAT" >/dev/null \
  || fail "v3 format mismatch error was not explicit"

V3_EMPTY_KEY_DIR="$TEST_ROOT/v3-empty-key-archive"
mkdir -p "$V3_EMPTY_KEY_DIR/secrets"
printf '   \n' > "$V3_EMPTY_KEY_DIR/secrets/config-encryption-key"
cp "$V3_DIR/manifest.env" "$V3_EMPTY_KEY_DIR/manifest.env"
set +e
empty_key_output=$(verify_archive_config_key_fingerprint "$V3_EMPTY_KEY_DIR" 3 2>&1)
empty_key_status=$?
set -e
[ "$empty_key_status" -ne 0 ] \
  || fail "v3 whitespace-only config encryption key unexpectedly passed"
printf '%s' "$empty_key_output" \
  | grep -F "empty after trimming" >/dev/null \
  || fail "v3 whitespace-only key error was not explicit"

V3_MISSING_FINGERPRINT_DIR="$TEST_ROOT/v3-missing-fingerprint-archive"
mkdir -p "$V3_MISSING_FINGERPRINT_DIR/secrets"
cp "$V3_DIR/secrets/config-encryption-key" \
  "$V3_MISSING_FINGERPRINT_DIR/secrets/config-encryption-key"
grep -v '^CONFIG_ENCRYPTION_KEY_SHA256=' "$V3_DIR/manifest.env" \
  > "$V3_MISSING_FINGERPRINT_DIR/manifest.env"
set +e
missing_fingerprint_output=$(
  verify_archive_config_key_fingerprint "$V3_MISSING_FINGERPRINT_DIR" 3 2>&1
)
missing_fingerprint_status=$?
set -e
[ "$missing_fingerprint_status" -ne 0 ] \
  || fail "v3 missing config encryption key fingerprint unexpectedly passed"
printf '%s' "$missing_fingerprint_output" \
  | grep -F "CONFIG_ENCRYPTION_KEY_SHA256 exactly once" >/dev/null \
  || fail "v3 missing fingerprint error was not explicit"

for required_field in \
  RUNTIME_APP_VERSION \
  RUNTIME_SOURCE_COMMIT \
  RUNTIME_IMAGE_ID \
  BUILD_TIMESTAMP \
  BACKUP_TOOL_COMMIT \
  BACKUP_TOOL_SCRIPT_SHA256 \
  CONFIG_ENCRYPTION_KEY_SHA256 \
  CONFIG_ENCRYPTION_KEY_FORMAT
do
  missing_field_manifest="$TEST_ROOT/v3-missing-$required_field.env"
  grep -v "^$required_field=" "$V3_DIR/manifest.env" > "$missing_field_manifest"
  set +e
  missing_field_output=$(read_archive_provenance "$missing_field_manifest" 3 2>&1)
  missing_field_status=$?
  set -e
  [ "$missing_field_status" -ne 0 ] \
    || fail "v3 manifest missing $required_field unexpectedly passed"
  printf '%s' "$missing_field_output" \
    | grep -F "$required_field exactly once" >/dev/null \
    || fail "v3 missing $required_field error was not explicit"
done

duplicate_manifest="$TEST_ROOT/v3-duplicate.env"
cp "$V3_DIR/manifest.env" "$duplicate_manifest"
printf '%s\n' "RUNTIME_SOURCE_COMMIT=$VALID_COMMIT" >> "$duplicate_manifest"
set +e
duplicate_output=$(read_archive_provenance "$duplicate_manifest" 3 2>&1)
duplicate_status=$?
set -e
[ "$duplicate_status" -ne 0 ] \
  || fail "v3 duplicate provenance field unexpectedly passed"
printf '%s' "$duplicate_output" \
  | grep -F "RUNTIME_SOURCE_COMMIT exactly once" >/dev/null \
  || fail "v3 duplicate field error was not explicit"

duplicate_format_manifest="$TEST_ROOT/v3-duplicate-format.env"
cp "$V3_DIR/manifest.env" "$duplicate_format_manifest"
printf '%s\n' "CONFIG_ENCRYPTION_KEY_FORMAT=legacy" >> "$duplicate_format_manifest"
set +e
duplicate_format_output=$(read_archive_provenance "$duplicate_format_manifest" 3 2>&1)
duplicate_format_status=$?
set -e
[ "$duplicate_format_status" -ne 0 ] \
  || fail "v3 duplicate config key format unexpectedly passed"
printf '%s' "$duplicate_format_output" \
  | grep -F "CONFIG_ENCRYPTION_KEY_FORMAT exactly once" >/dev/null \
  || fail "v3 duplicate config key format error was not explicit"

bad_hex_manifest="$TEST_ROOT/v3-bad-hex.env"
sed 's/^BACKUP_TOOL_SCRIPT_SHA256=.*/BACKUP_TOOL_SCRIPT_SHA256=ABCDEF/' \
  "$V3_DIR/manifest.env" > "$bad_hex_manifest"
set +e
bad_hex_output=$(read_archive_provenance "$bad_hex_manifest" 3 2>&1)
bad_hex_status=$?
set -e
[ "$bad_hex_status" -ne 0 ] || fail "v3 bad backup script hex unexpectedly passed"
printf '%s' "$bad_hex_output" | grep -F "64 lowercase hex" >/dev/null \
  || fail "v3 bad backup script hex error was not explicit"

bad_image_manifest="$TEST_ROOT/v3-bad-image.env"
sed 's/^RUNTIME_IMAGE_ID=.*/RUNTIME_IMAGE_ID=sha256:nothex/' \
  "$V3_DIR/manifest.env" > "$bad_image_manifest"
set +e
bad_image_output=$(read_archive_provenance "$bad_image_manifest" 3 2>&1)
bad_image_status=$?
set -e
[ "$bad_image_status" -ne 0 ] || fail "v3 bad image id unexpectedly passed"
printf '%s' "$bad_image_output" | grep -F "sha256: plus 64 lowercase hex" >/dev/null \
  || fail "v3 bad image id error was not explicit"

backup_unknown_image_manifest="$TEST_ROOT/v3-backup-unknown-image.env"
sed 's/^RUNTIME_IMAGE_ID=.*/RUNTIME_IMAGE_ID=unknown/' \
  "$V3_DIR/manifest.env" > "$backup_unknown_image_manifest"
set +e
backup_unknown_image_output=$(validate_v3_manifest_file "$backup_unknown_image_manifest" backup 2>&1)
backup_unknown_image_status=$?
set -e
[ "$backup_unknown_image_status" -ne 0 ] \
  || fail "backup-side v3 manifest with unknown image ID unexpectedly passed"
printf '%s' "$backup_unknown_image_output" \
  | grep -F "RUNTIME_IMAGE_ID" >/dev/null \
  || fail "backup-side unknown image ID error did not name RUNTIME_IMAGE_ID"

bad_timestamp_manifest="$TEST_ROOT/v3-bad-timestamp.env"
sed 's/^BUILD_TIMESTAMP=.*/BUILD_TIMESTAMP=not-a-timestamp/' \
  "$V3_DIR/manifest.env" > "$bad_timestamp_manifest"
set +e
bad_timestamp_output=$(validate_v3_manifest_file "$bad_timestamp_manifest" 2>&1)
bad_timestamp_status=$?
set -e
[ "$bad_timestamp_status" -ne 0 ] || fail "v3 bad timestamp unexpectedly passed"
printf '%s' "$bad_timestamp_output" | grep -F "BUILD_TIMESTAMP" >/dev/null \
  || fail "v3 bad timestamp error did not name BUILD_TIMESTAMP"

bad_commit_manifest="$TEST_ROOT/v3-bad-commit.env"
sed 's/^RUNTIME_SOURCE_COMMIT=.*/RUNTIME_SOURCE_COMMIT=abc123/' \
  "$V3_DIR/manifest.env" > "$bad_commit_manifest"
set +e
bad_commit_output=$(validate_v3_manifest_file "$bad_commit_manifest" 2>&1)
bad_commit_status=$?
set -e
[ "$bad_commit_status" -ne 0 ] || fail "v3 bad source commit unexpectedly passed"
printf '%s' "$bad_commit_output" | grep -F "RUNTIME_SOURCE_COMMIT" >/dev/null \
  || fail "v3 bad source commit error did not name RUNTIME_SOURCE_COMMIT"

bad_format_manifest="$TEST_ROOT/v3-bad-format.env"
sed 's/^CONFIG_ENCRYPTION_KEY_FORMAT=.*/CONFIG_ENCRYPTION_KEY_FORMAT=v2/' \
  "$V3_DIR/manifest.env" > "$bad_format_manifest"
set +e
bad_format_output=$(read_archive_provenance "$bad_format_manifest" 3 2>&1)
bad_format_status=$?
set -e
[ "$bad_format_status" -ne 0 ] || fail "v3 bad config key format unexpectedly passed"
printf '%s' "$bad_format_output" | grep -F "CONFIG_ENCRYPTION_KEY_FORMAT must be legacy or v1" >/dev/null \
  || fail "v3 bad config key format error was not explicit"

empty_format_manifest="$TEST_ROOT/v3-empty-format.env"
sed 's/^CONFIG_ENCRYPTION_KEY_FORMAT=.*/CONFIG_ENCRYPTION_KEY_FORMAT=/' \
  "$V3_DIR/manifest.env" > "$empty_format_manifest"
set +e
empty_format_output=$(read_archive_provenance "$empty_format_manifest" 3 2>&1)
empty_format_status=$?
set -e
[ "$empty_format_status" -ne 0 ] || fail "v3 empty config key format unexpectedly passed"
printf '%s' "$empty_format_output" | grep -F "empty CONFIG_ENCRYPTION_KEY_FORMAT" >/dev/null \
  || fail "v3 empty config key format error was not explicit"

control_manifest="$TEST_ROOT/v3-control.env"
sed 's/^RUNTIME_APP_VERSION=.*/RUNTIME_APP_VERSION=bad\tversion/' \
  "$V3_DIR/manifest.env" > "$control_manifest"
set +e
control_output=$(read_archive_provenance "$control_manifest" 3 2>&1)
control_status=$?
set -e
[ "$control_status" -ne 0 ] || fail "v3 control character field unexpectedly passed"
printf '%s' "$control_output" | grep -F "RUNTIME_APP_VERSION contains control characters" >/dev/null \
  || fail "v3 control character error was not explicit"

legacy_manifest="$TEST_ROOT/v2-provenance-less.env"
cat > "$legacy_manifest" <<'EOF'
FORMAT_VERSION=2
APP_VERSION=legacy-host-version
EOF
read_archive_provenance "$legacy_manifest" 2
[ "$ARCHIVE_RUNTIME_APP_VERSION" = "legacy-host-version" ] \
  || fail "legacy v2 app version fallback did not parse"
[ "$ARCHIVE_RUNTIME_SOURCE_COMMIT" = "unknown" ] \
  || fail "legacy v2 source commit did not default to unknown"

for legacy_format in 1 2; do
  set +e
  legacy_warning=$(warn_legacy_provenance_if_needed "$legacy_format" 2>&1)
  legacy_warning_status=$?
  set -e
  [ "$legacy_warning_status" -eq 0 ] \
    || fail "legacy provenance warning failed for FORMAT_VERSION=$legacy_format"
  printf '%s' "$legacy_warning" \
    | grep -F "predates image-authoritative backup provenance" >/dev/null \
    || fail "legacy provenance warning missing for FORMAT_VERSION=$legacy_format"

  set +e
  fingerprint_warning=$(verify_archive_config_key_fingerprint "$V3_DIR" "$legacy_format" 2>&1)
  fingerprint_warning_status=$?
  set -e
  [ "$fingerprint_warning_status" -eq 0 ] \
    || fail "legacy fingerprint warning failed for FORMAT_VERSION=$legacy_format"
  printf '%s' "$fingerprint_warning" \
    | grep -F "has no CONFIG_ENCRYPTION_KEY_SHA256 fingerprint" >/dev/null \
    || fail "legacy fingerprint warning missing for FORMAT_VERSION=$legacy_format"
done

set +e
v3_legacy_warning=$(warn_legacy_provenance_if_needed 3 2>&1)
v3_legacy_warning_status=$?
set -e
[ "$v3_legacy_warning_status" -eq 0 ] || fail "v3 provenance warning helper failed"
[ -z "$v3_legacy_warning" ] || fail "v3 emitted a legacy provenance warning"

set +e
provenance_mismatch_warning=$(warn_if_mismatch "runtime source commit" "$VALID_COMMIT" "fedcba9876543210fedcba9876543210fedcba98" 2>&1)
provenance_mismatch_status=$?
set -e
[ "$provenance_mismatch_status" -eq 0 ] || fail "provenance mismatch warning failed"
printf '%s' "$provenance_mismatch_warning" \
  | grep -F "migration identity remains the hard compatibility gate" >/dev/null \
  || fail "provenance mismatch warning did not preserve migration hard-gate language"

fingerprint_line=$(
  awk '/verify_archive_config_key_fingerprint/ { print NR; exit }' "$ROOT_DIR/scripts/restore.sh"
)
first_destructive_line=$(
  awk '/Replacing PostgreSQL database/ { print NR; exit }' "$ROOT_DIR/scripts/restore.sh"
)
[ -n "$fingerprint_line" ] || fail "restore.sh does not call verify_archive_config_key_fingerprint"
[ -n "$first_destructive_line" ] || fail "restore.sh destructive database boundary was not found"
[ "$fingerprint_line" -lt "$first_destructive_line" ] \
  || fail "config key fingerprint check moved after destructive database boundary"

backup_manifest_validation_line=$(
  awk 'index($0, "validate_v3_manifest_file \"$WORK_DIR/manifest.env\" backup") { print NR; exit }' "$ROOT_DIR/scripts/backup.sh"
)
backup_restart_line=$(
  awk 'index($0, "restart_app_if_needed || fail \"unable to restart app service after consistent backup capture\"") { print NR; exit }' "$ROOT_DIR/scripts/backup.sh"
)
backup_checksum_line=$(
  awk 'index($0, "Generating archive checksums") { print NR; exit }' "$ROOT_DIR/scripts/backup.sh"
)
[ -n "$backup_manifest_validation_line" ] || fail "backup.sh does not validate manifest.env after writing it"
[ -n "$backup_restart_line" ] || fail "backup.sh restart_app_if_needed call was not found"
[ -n "$backup_checksum_line" ] || fail "backup.sh checksum generation was not found"
[ "$backup_manifest_validation_line" -lt "$backup_restart_line" ] \
  || fail "backup manifest validation moved after restart_app_if_needed"
[ "$backup_manifest_validation_line" -lt "$backup_checksum_line" ] \
  || fail "backup manifest validation moved after checksum generation"

confirm_line=$(
  awk '/Type RESTORE to continue/ { print NR; exit }' "$ROOT_DIR/scripts/restore.sh"
)
preconfirm_create_line=$(
  awk '/compose create app/ { print NR; exit }' "$ROOT_DIR/scripts/restore.sh"
)
[ -n "$confirm_line" ] || fail "restore.sh confirmation prompt was not found"
[ -n "$preconfirm_create_line" ] || fail "restore.sh app container creation was not found"
[ "$preconfirm_create_line" -gt "$confirm_line" ] \
  || fail "restore.sh creates the app container before confirmation"

: > "$COMPOSE_MUTATION_LOG"
COMPOSE_PS_APP_OUTPUT=""
read_restore_target_provenance_read_only
[ "$RUNTIME_APP_VERSION" = "compose-config-version" ] \
  || fail "read-only restore provenance did not inspect compose image labels"
if grep -E '^(create|up|run) ' "$COMPOSE_MUTATION_LOG" >/dev/null; then
  fail "read-only restore provenance mutated compose state"
fi
COMPOSE_PS_APP_OUTPUT=mock-app-container

verify_restore_target_unchanged_after_create \
  true \
  mock-app-container \
  image-version \
  "$VALID_COMMIT" \
  2026-07-05T00:00:00Z \
  "$VALID_IMAGE_ID" >/dev/null \
  || fail "restore post-create guard rejected unchanged target"
[ "$RESTORE_APP_CONTAINER_ID" = "mock-app-container" ] \
  || fail "restore post-create guard did not store the verified container id"

DOCKER_IMAGE_ID_JSON='"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"'
set +e
restore_changed_image_output=$(
  verify_restore_target_unchanged_after_create \
    true \
    mock-app-container \
    image-version \
    "$VALID_COMMIT" \
    2026-07-05T00:00:00Z \
    "$VALID_IMAGE_ID" 2>&1
)
restore_changed_image_status=$?
set -e
DOCKER_IMAGE_ID_JSON='"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
[ "$restore_changed_image_status" -ne 0 ] \
  || fail "restore post-create guard accepted a changed image"
printf '%s' "$restore_changed_image_output" \
  | grep -F "target app container/image changed after confirmation" >/dev/null \
  || fail "restore changed-image error was not explicit"

restore_unknown_output=$(
  verify_restore_target_unchanged_after_create \
    false \
    "" \
    unknown \
    unknown \
    unknown \
    unknown
)
printf '%s' "$restore_unknown_output" \
  | grep -F "Target provenance resolved after container creation:" >/dev/null \
  || fail "restore all-unknown post-create path did not announce resolved provenance"
[ "$TARGET_RUNTIME_IMAGE_ID" = "$VALID_IMAGE_ID" ] \
  || fail "restore all-unknown post-create path did not replace target image id"

command -v script >/dev/null 2>&1 \
  || fail "script command is required for restore cancellation tty regression test"

RESTORE_CANCEL_PAYLOAD="$TEST_ROOT/restore-cancel-payload"
RESTORE_CANCEL_ARCHIVE="$TEST_ROOT/restore-cancel.tar.gz"
RESTORE_CANCEL_FAKE_BIN="$TEST_ROOT/fake-bin"
RESTORE_CANCEL_MUTATION_LOG="$TEST_ROOT/restore-cancel-mutations.log"
RESTORE_CANCEL_RUNNER="$TEST_ROOT/run-cancel-restore.sh"
mkdir -p "$RESTORE_CANCEL_PAYLOAD/secrets" "$RESTORE_CANCEL_FAKE_BIN"
printf 'select 1;\n' > "$RESTORE_CANCEL_PAYLOAD/db.sql"
printf '  config-key-material  \n' > "$RESTORE_CANCEL_PAYLOAD/secrets/config-encryption-key"
: > "$RESTORE_CANCEL_PAYLOAD/UPLOADS_SKIPPED_S3"
: > "$RESTORE_CANCEL_MUTATION_LOG"
cat > "$RESTORE_CANCEL_PAYLOAD/manifest.env" <<EOF
FORMAT_VERSION=3
CREATED_AT_UTC=2026-07-05T00:00:00Z
APP_VERSION=image-version
RUNTIME_APP_VERSION=image-version
RUNTIME_SOURCE_COMMIT=$VALID_COMMIT
RUNTIME_IMAGE_ID=$VALID_IMAGE_ID
BUILD_TIMESTAMP=2026-07-05T00:00:00Z
BACKUP_TOOL_COMMIT=$VALID_TOOL_COMMIT
BACKUP_TOOL_SCRIPT_SHA256=$VALID_TOOL_SHA
STORAGE_DRIVER=s3
UPLOADS_INCLUDED=false
LATEST_MIGRATION_HASH=unused-before-confirmation
MIGRATION_IDENTITIES_JSON=[]
CONFIG_ENCRYPTION_KEY_FILE=/app/secrets/config-encryption-key
CONFIG_ENCRYPTION_KEY_SHA256=$CONFIG_KEY_SHA256
CONFIG_ENCRYPTION_KEY_FORMAT=legacy
SESSION_SECRET_SOURCE=external
SESSION_SECRET_SHA256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
BACKUP_WINDOW_NOTE=restore cancellation fixture
EOF
(
  cd "$RESTORE_CANCEL_PAYLOAD" || exit 1
  find . -type f ! -path './checksums.sha256' -print \
    | LC_ALL=C sort \
    | while IFS= read -r path; do
        rel=${path#./}
        sha256sum "$rel"
      done
) > "$RESTORE_CANCEL_PAYLOAD/checksums.sha256"
tar -czf "$RESTORE_CANCEL_ARCHIVE" -C "$RESTORE_CANCEL_PAYLOAD" .

cat > "$RESTORE_CANCEL_FAKE_BIN/docker" <<'SH'
#!/bin/sh
set -eu

case "$1" in
  info)
    exit 0
    ;;
  compose)
    shift
    case "$1" in
      version)
        exit 0
        ;;
      ps)
        [ "$2" = "-aq" ] || exit 1
        [ "$3" = "app" ] || exit 1
        exit 0
        ;;
      config)
        [ "$2" = "--images" ] || exit 1
        [ "$3" = "app" ] || exit 1
        printf '%s\n' "$COMPOSE_APP_IMAGE"
        exit 0
        ;;
      create|up|run)
        printf '%s\n' "compose $*" >> "$RESTORE_CANCEL_MUTATION_LOG"
        exit 0
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  image)
    shift
    [ "$1" = "inspect" ] || exit 1
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --format)
          shift 2
          ;;
        *)
          [ "$1" = "$COMPOSE_APP_IMAGE" ] || exit 1
          shift
          ;;
      esac
    done
    printf '%s %s\n' "$DOCKER_IMAGE_LABELS_JSON" "$DOCKER_IMAGE_ID_JSON"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
SH
chmod +x "$RESTORE_CANCEL_FAKE_BIN/docker"
cat > "$RESTORE_CANCEL_RUNNER" <<EOF
#!/bin/sh
exec "$ROOT_DIR/scripts/restore.sh" "$RESTORE_CANCEL_ARCHIVE"
EOF
chmod +x "$RESTORE_CANCEL_RUNNER"
set +e
restore_cancel_output=$(
  printf 'NO\n' \
    | env \
        PATH="$RESTORE_CANCEL_FAKE_BIN:$PATH" \
        COMPOSE_APP_IMAGE="$COMPOSE_APP_IMAGE" \
        DOCKER_IMAGE_LABELS_JSON="$DOCKER_IMAGE_LABELS_JSON" \
        DOCKER_IMAGE_ID_JSON="$DOCKER_IMAGE_ID_JSON" \
        RESTORE_CANCEL_MUTATION_LOG="$RESTORE_CANCEL_MUTATION_LOG" \
        script -qec "$RESTORE_CANCEL_RUNNER" /dev/null 2>&1
)
restore_cancel_status=$?
set -e
[ "$restore_cancel_status" -ne 0 ] || fail "declined restore unexpectedly succeeded"
printf '%s' "$restore_cancel_output" | grep -F "restore cancelled" >/dev/null \
  || fail "declined restore did not reach cancellation prompt"
printf '%s' "$restore_cancel_output" | grep -F "Config key format: legacy" >/dev/null \
  || fail "declined v3 restore prompt did not show config key format"
if grep -E '^compose (create|up|run)' "$RESTORE_CANCEL_MUTATION_LOG" >/dev/null; then
  fail "declined restore performed compose create/up/run before confirmation"
fi

cat > "$TEST_ROOT/db-with-app-settings.sql" <<'SQL'
--
COPY public.app_settings (key, value_encrypted, updated_at) FROM stdin;
smtp	v1:encrypted	2026-01-01 00:00:00+00
storage	v1:encrypted2	2026-01-01 00:00:00+00
\.
--
SQL
extract_app_settings_copy_block \
  "$TEST_ROOT/db-with-app-settings.sql" "$TEST_ROOT/app-settings-copy.sql" \
  || fail "failed to extract app_settings COPY block"
grep -F "COPY public.app_settings" "$TEST_ROOT/app-settings-copy.sql" >/dev/null \
  || fail "extracted app_settings COPY block missing header"
app_settings_copy_block_has_rows "$TEST_ROOT/app-settings-copy.sql" \
  || fail "app_settings COPY block with rows was reported empty"
scratch_sql=$(app_settings_scratch_create_table_sql "$TEST_ROOT/app-settings-copy.sql") \
  || fail "failed to build current-era app_settings scratch table SQL"
[ "$scratch_sql" = "create table public.app_settings (key text, value_encrypted text, updated_at text)" ] \
  || fail "current-era scratch SQL was unexpected: $scratch_sql"

cat > "$TEST_ROOT/db-future-app-settings.sql" <<'SQL'
COPY public.app_settings (key, value_encrypted, updated_at, future_column) FROM stdin;
smtp	v1:encrypted	2026-01-01 00:00:00+00	future
\.
SQL
extract_app_settings_copy_block \
  "$TEST_ROOT/db-future-app-settings.sql" "$TEST_ROOT/future-app-settings-copy.sql" \
  || fail "failed to extract future app_settings COPY block"
future_scratch_sql=$(app_settings_scratch_create_table_sql "$TEST_ROOT/future-app-settings-copy.sql") \
  || fail "failed to build future app_settings scratch table SQL"
[ "$future_scratch_sql" = "create table public.app_settings (key text, value_encrypted text, updated_at text, future_column text)" ] \
  || fail "future scratch SQL was unexpected: $future_scratch_sql"

cat > "$TEST_ROOT/db-missing-value-encrypted.sql" <<'SQL'
COPY public.app_settings (key, updated_at) FROM stdin;
smtp	2026-01-01 00:00:00+00
\.
SQL
extract_app_settings_copy_block \
  "$TEST_ROOT/db-missing-value-encrypted.sql" "$TEST_ROOT/missing-value-encrypted-copy.sql" \
  || fail "failed to extract missing-value app_settings COPY block"
set +e
missing_value_output=$(
  app_settings_scratch_create_table_sql "$TEST_ROOT/missing-value-encrypted-copy.sql" 2>&1
)
missing_value_status=$?
set -e
[ "$missing_value_status" -ne 0 ] \
  || fail "missing value_encrypted header unexpectedly produced scratch SQL"
printf '%s' "$missing_value_output" | grep -F "archive app_settings has no value_encrypted column" >/dev/null \
  || fail "missing value_encrypted error was not explicit"

cat > "$TEST_ROOT/db-hostile-app-settings.sql" <<'SQL'
COPY public.app_settings (key, "value_encrypted", updated_at) FROM stdin;
smtp	v1:encrypted	2026-01-01 00:00:00+00
\.
SQL
extract_app_settings_copy_block \
  "$TEST_ROOT/db-hostile-app-settings.sql" "$TEST_ROOT/hostile-app-settings-copy.sql" \
  || fail "failed to extract hostile app_settings COPY block"
set +e
hostile_output=$(
  app_settings_scratch_create_table_sql "$TEST_ROOT/hostile-app-settings-copy.sql" 2>&1
)
hostile_status=$?
set -e
[ "$hostile_status" -ne 0 ] \
  || fail "hostile app_settings identifier unexpectedly produced scratch SQL"
printf '%s' "$hostile_output" | grep -F "archive app_settings contains unsupported column identifier" >/dev/null \
  || fail "hostile identifier error was not explicit"

cat > "$TEST_ROOT/db-without-app-settings.sql" <<'SQL'
--
COPY public.users (id, email) FROM stdin;
\.
SQL
set +e
extract_app_settings_copy_block \
  "$TEST_ROOT/db-without-app-settings.sql" "$TEST_ROOT/no-app-settings-copy.sql"
missing_status=$?
set -e
if [ "$missing_status" -eq 0 ]; then
  fail "extract_app_settings_copy_block unexpectedly found missing table"
fi
[ "$missing_status" -eq 1 ] || fail "missing app_settings COPY block returned unexpected status"

cat > "$TEST_ROOT/db-empty-app-settings.sql" <<'SQL'
COPY public.app_settings (key, value_encrypted, updated_at) FROM stdin;
\.
SQL
extract_app_settings_copy_block \
  "$TEST_ROOT/db-empty-app-settings.sql" "$TEST_ROOT/empty-app-settings-copy.sql" \
  || fail "failed to extract empty app_settings COPY block"
if app_settings_copy_block_has_rows "$TEST_ROOT/empty-app-settings-copy.sql"; then
  fail "empty app_settings COPY block was reported non-empty"
fi

if grep -nE 'compose (run|exec).*sh -c "' \
  "$ROOT_DIR/scripts/restore.sh" "$ROOT_DIR/scripts/restore-common.sh" \
  | grep -v 'sh -c "\$script" restore-'; then
  fail "restore scripts still contain double-quoted sh -c command text"
fi
if grep -nE 'run_(app|postgres)_shell "' \
  "$ROOT_DIR/scripts/restore.sh" "$ROOT_DIR/scripts/restore-common.sh"; then
  fail "restore scripts still construct child-shell command text with double quotes"
fi

echo "Restore shell argument tests passed"
