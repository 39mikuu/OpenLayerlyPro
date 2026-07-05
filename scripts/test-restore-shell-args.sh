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

DOCKER_INSPECT_ENV_JSON='["APP_VERSION=inspect-version","SOURCE_COMMIT=commit=with=equals","BUILD_TIMESTAMP=2026-07-05T00:00:00Z"]'
DOCKER_INSPECT_IMAGE_JSON='"sha256:inspect-image"'
COMPOSE_PS_APP_OUTPUT=mock-app-container

docker_cmd() {
  action=$1
  shift
  case "$action" in
    inspect)
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --format)
            shift 2
            ;;
          *)
            [ "$1" = "mock-app-container" ] || fail "mock docker inspect received unexpected container id: $1"
            shift
            ;;
        esac
      done
      printf '%s %s\n' "$DOCKER_INSPECT_ENV_JSON" "$DOCKER_INSPECT_IMAGE_JSON"
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
      [ "$1" = "app" ] || fail "mock compose create did not receive app service"
      return
      ;;
    ps)
      [ "$1" = "-aq" ] || fail "mock compose ps expected -aq"
      [ "$2" = "app" ] || fail "mock compose ps did not receive app service"
      printf '%s\n' "$COMPOSE_PS_APP_OUTPUT"
      return
      ;;
    run)
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

single_container_id=$(resolve_single_app_container_id)
[ "$single_container_id" = "mock-app-container" ] \
  || fail "single app container id did not resolve from compose ps"
read_app_container_provenance "$single_container_id"
[ "$RUNTIME_APP_VERSION" = "inspect-version" ] \
  || fail "inspected app version was not read from the service container"
[ "$RUNTIME_SOURCE_COMMIT" = "commit=with=equals" ] \
  || fail "inspected source commit did not preserve '=' characters"
[ "$BUILD_TIMESTAMP" = "2026-07-05T00:00:00Z" ] \
  || fail "inspected build timestamp was not read from the service container"
[ "$RUNTIME_IMAGE_ID" = "sha256:inspect-image" ] \
  || fail "inspected image ID was not read from the same service container"

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
cat > "$V3_DIR/manifest.env" <<EOF
FORMAT_VERSION=3
APP_VERSION=host-checkout-version
RUNTIME_APP_VERSION=image-version
RUNTIME_SOURCE_COMMIT=image-commit
RUNTIME_IMAGE_ID=sha256:image-id
BUILD_TIMESTAMP=2026-07-05T00:00:00Z
BACKUP_TOOL_COMMIT=tool-commit
BACKUP_TOOL_SCRIPT_SHA256=tool-script-sha
CONFIG_ENCRYPTION_KEY_SHA256=$CONFIG_KEY_SHA256
EOF

read_archive_provenance "$V3_DIR/manifest.env"
[ "$ARCHIVE_RUNTIME_APP_VERSION" = "image-version" ] \
  || fail "v3 provenance did not prefer runtime image app version"
[ "$ARCHIVE_RUNTIME_SOURCE_COMMIT" = "image-commit" ] \
  || fail "v3 provenance did not parse runtime source commit"
[ "$ARCHIVE_RUNTIME_IMAGE_ID" = "sha256:image-id" ] \
  || fail "v3 provenance did not parse runtime image ID"
[ "$ARCHIVE_BUILD_TIMESTAMP" = "2026-07-05T00:00:00Z" ] \
  || fail "v3 provenance did not parse build timestamp"
[ "$ARCHIVE_BACKUP_TOOL_COMMIT" = "tool-commit" ] \
  || fail "v3 provenance did not parse backup tool commit"
[ "$ARCHIVE_BACKUP_TOOL_SCRIPT_SHA256" = "tool-script-sha" ] \
  || fail "v3 provenance did not parse backup tool script hash"
verify_archive_config_key_fingerprint "$V3_DIR" 3 \
  || fail "v3 config encryption key fingerprint did not match trimmed key material"

V3_BAD_DIR="$TEST_ROOT/v3-bad-archive"
mkdir -p "$V3_BAD_DIR/secrets"
cp "$V3_DIR/secrets/config-encryption-key" "$V3_BAD_DIR/secrets/config-encryption-key"
sed "s/^CONFIG_ENCRYPTION_KEY_SHA256=.*/CONFIG_ENCRYPTION_KEY_SHA256=000000/" \
  "$V3_DIR/manifest.env" > "$V3_BAD_DIR/manifest.env"
set +e
fingerprint_mismatch_output=$(verify_archive_config_key_fingerprint "$V3_BAD_DIR" 3 2>&1)
fingerprint_mismatch_status=$?
set -e
[ "$fingerprint_mismatch_status" -ne 0 ] \
  || fail "v3 config encryption key fingerprint mismatch unexpectedly passed"
printf '%s' "$fingerprint_mismatch_output" \
  | grep -F "CONFIG_ENCRYPTION_KEY_SHA256" >/dev/null \
  || fail "v3 fingerprint mismatch error was not explicit"

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
  | grep -F "archive manifest is missing CONFIG_ENCRYPTION_KEY_SHA256" >/dev/null \
  || fail "v3 missing fingerprint error was not explicit"

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
provenance_mismatch_warning=$(warn_if_mismatch "runtime source commit" "image-commit" "target-commit" 2>&1)
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
