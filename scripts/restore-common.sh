#!/bin/sh
# shellcheck disable=SC2016 # Expand Compose service variables inside the container shell.
# Shared helpers for backup.sh and restore.sh (sourced, not executed directly).

run_app_shell() {
  script=$1
  shift
  compose run --rm -T --no-deps --entrypoint sh app -c "$script" restore-app "$@"
}

run_postgres_shell() {
  script=$1
  shift
  compose exec -T postgres sh -c "$script" restore-postgres "$@"
}

verify_container_nonempty_file() {
  target_file=$1
  run_app_shell '
    set -eu
    test -f "$1"
    test -s "$1"
  ' "$target_file"
}

clear_container_directory() {
  target_dir=$1
  run_app_shell '
    set -eu
    mkdir -p "$1"
    rm -rf "$1"/* "$1"/.[!.]* "$1"/..?*
  ' "$target_dir"
}

remove_container_object() {
  target_dir=$1
  object_key=$2
  run_app_shell '
    set -eu
    rm -f "$1/$2"
    test ! -f "$1/$2"
  ' "$target_dir" "$object_key"
}

remove_first_container_text_file() {
  target_dir=$1
  run_app_shell '
    set -eu
    referenced=$(find "$1" -type f -name "*.txt" | head -n 1)
    [ -n "$referenced" ] || exit 1
    rm -f "$referenced"
  ' "$target_dir"
}

validate_absolute_container_path() {
  path=$1
  label=$2

  case "$path" in
    /*) ;;
    *) fail "$label must be an absolute container path" ;;
  esac
}

validate_no_path_traversal() {
  path=$1
  label=$2

  case "$path" in
    *..*) fail "$label must not contain '..'" ;;
    *"/./"*) fail "$label must not contain '/./'" ;;
  esac
}

# Reject symlinks and non-regular (special: block/char/fifo/socket) files anywhere in an
# extracted archive payload tree. restore.sh calls this immediately after extraction and
# before any database replacement; the checksum-gate regression test calls this exact
# helper against malicious archives, so the test exercises the real production rejection.
reject_unsafe_payload_tree() {
  payload_dir=$1

  if [ -n "$(find "$payload_dir" -type l -print -quit 2>/dev/null || true)" ]; then
    fail "archive contains symlinks; only regular payload files are supported"
  fi
  if [ -n "$(find "$payload_dir" \( -type b -o -type c -o -type p -o -type s \) -print -quit 2>/dev/null || true)" ]; then
    fail "archive contains special files; only regular payload files are supported"
  fi
}

manifest_value() {
  manifest_path=$1
  key=$2
  value=$(grep "^${key}=" "$manifest_path" | cut -d= -f2- | tr -d '\r')
  [ -n "$value" ] || fail "archive manifest is missing $key"
  printf '%s' "$value"
}

# Validate the archive's storage payload and its v2 semantic contract before any
# target service is stopped or official database/key/upload state is replaced.
validate_archive_storage_contract() {
  payload_dir=$1
  format_version=$2
  has_uploads=false
  has_skip_marker=false
  [ -d "$payload_dir/uploads" ] && has_uploads=true
  [ -f "$payload_dir/UPLOADS_SKIPPED_S3" ] && has_skip_marker=true

  if [ "$has_uploads" = "$has_skip_marker" ]; then
    fail "archive must contain exactly one of uploads/ or UPLOADS_SKIPPED_S3"
  fi

  [ "$format_version" = "2" ] || return 0
  storage_driver=$(manifest_value "$payload_dir/manifest.env" STORAGE_DRIVER)
  uploads_included=$(manifest_value "$payload_dir/manifest.env" UPLOADS_INCLUDED)
  case "$storage_driver:$uploads_included:$has_uploads:$has_skip_marker" in
    local:true:true:false|s3:false:false:true) ;;
    *)
      fail "archive storage payload does not match manifest STORAGE_DRIVER/UPLOADS_INCLUDED"
      ;;
  esac
}

canonicalize_container_path() {
  raw_path=$1
  label=$2

  validate_absolute_container_path "$raw_path" "$label"
  validate_no_path_traversal "$raw_path" "$label"

  canonical_path=$(
    run_app_shell '
      set -eu
      if command -v realpath >/dev/null 2>&1; then
        realpath -m -- "$1"
      else
        printf "%s\n" "$1"
      fi
    ' "$raw_path" | tr -d '\r'
  )
  [ -n "$canonical_path" ] || fail "unable to canonicalize $label"

  validate_absolute_container_path "$canonical_path" "$label"
  validate_no_path_traversal "$canonical_path" "$label"
  printf '%s' "$canonical_path"
}

validate_path_under_mount() {
  path=$1
  mount_root=$2
  label=$3

  canonical_path=$(canonicalize_container_path "$path" "$label")

  case "$canonical_path" in
    "$mount_root") ;;
    "$mount_root"/*) ;;
    *) fail "$label must stay under $mount_root (resolved $canonical_path)" ;;
  esac
}

validate_config_key_file_path() {
  path=$1

  validate_path_under_mount "$path" "/app/secrets" "CONFIG_ENCRYPTION_KEY_FILE"
  case "$path" in
    /app/secrets) fail "CONFIG_ENCRYPTION_KEY_FILE must be a file path, not a directory" ;;
    */) fail "CONFIG_ENCRYPTION_KEY_FILE must be a file path, not a directory" ;;
  esac
}

validate_session_secret_file_path() {
  path=$1

  validate_path_under_mount "$path" "/app/secrets" "SESSION_SECRET_FILE"
  case "$path" in
    /app/secrets) fail "SESSION_SECRET_FILE must be a file path, not a directory" ;;
    */) fail "SESSION_SECRET_FILE must be a file path, not a directory" ;;
  esac
}

validate_upload_dir_path() {
  path=$1

  validate_path_under_mount "$path" "/app/uploads" "UPLOAD_DIR"
  case "$path" in
    */) fail "UPLOAD_DIR must not end with '/'" ;;
  esac
}

read_live_container_upload_dir() {
  compose exec -T app sh -c 'printf %s "${UPLOAD_DIR:-/app/uploads}"'
}

read_container_upload_dir() {
  compose run --rm -T --no-deps --entrypoint sh app -c \
    'printf %s "${UPLOAD_DIR:-/app/uploads}"'
}

read_live_container_config_key_file() {
  compose exec -T app sh -c \
    'printf %s "${CONFIG_ENCRYPTION_KEY_FILE:-/app/secrets/config-encryption-key}"'
}

read_container_config_key_file() {
  compose run --rm -T --no-deps --entrypoint sh app -c \
    'printf %s "${CONFIG_ENCRYPTION_KEY_FILE:-/app/secrets/config-encryption-key}"'
}

read_container_session_secret_file() {
  compose run --rm -T --no-deps --entrypoint sh app -c \
    'printf %s "${SESSION_SECRET_FILE:-/app/secrets/session-secret}"'
}

# Percent-encode a string for safe use in a URL userinfo (user/password) component.
# RFC 3986 unreserved characters are kept as-is; everything else becomes %XX so raw
# credentials containing @ : / ? # % etc. cannot corrupt the connection URL.
urlencode() {
  urlencode_in=$1
  urlencode_out=""
  urlencode_i=1
  urlencode_len=${#urlencode_in}
  while [ "$urlencode_i" -le "$urlencode_len" ]; do
    urlencode_ch=$(printf '%s' "$urlencode_in" | cut -c "$urlencode_i")
    case "$urlencode_ch" in
      [a-zA-Z0-9._~-]) urlencode_out="$urlencode_out$urlencode_ch" ;;
      *) urlencode_out="$urlencode_out$(printf '%%%02X' "'$urlencode_ch")" ;;
    esac
    urlencode_i=$((urlencode_i + 1))
  done
  printf '%s' "$urlencode_out"
}

# Cryptographically random, identifier-safe (lowercase hex) suffix for the isolated
# legacy-probe database name. Avoids predictable timestamp+PID names.
probe_db_suffix() {
  if [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -tx1 -N16 /dev/urandom | tr -d ' \n'
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    fail "no source of randomness available for the probe database name"
  fi
}

# Prove a one-off container can write a sentinel into $probe_dir that a *separate*
# one-off container can read back and delete. Catches read-only/tmpfs/unshared volumes
# before any destructive database work. Must be called before dropdb.
#
# The probe file is created with mktemp (exclusive O_EXCL creation, unpredictable name)
# *inside* the target mount, so it never overwrites or deletes a pre-existing file/
# symlink and concurrent restores never collide. Only the exact file created here is
# removed. Restore itself must never introduce data loss — including its own preflight.
preflight_volume_write_read_delete() {
  probe_dir=$1
  label=$2

  probe_token="restore-preflight-$(date +%s)-$$"
  probe_path=$(
    run_app_shell '
      set -eu
      umask 077
      probe=$(mktemp "$1/.restore-preflight.XXXXXX")
      printf "%s" "$2" > "$probe"
      printf "%s" "$probe"
    ' "$probe_dir" "$probe_token" | tr -d '\r'
  ) || fail "$label is not writable from a one-off container ($probe_dir)"
  [ -n "$probe_path" ] || fail "$label preflight could not create a probe file ($probe_dir)"

  probe_readback=$(
    run_app_shell '
      set -eu
      [ -f "$1" ] || exit 1
      [ ! -L "$1" ] || exit 1
      cat "$1"
      rm -f "$1"
    ' "$probe_path" | tr -d '\r'
  ) || fail "$label failed cross-container read/delete preflight ($probe_path)"

  [ "$probe_readback" = "$probe_token" ] \
    || fail "$label is not shared across one-off containers ($probe_path)"
}

preflight_config_key_restore_target() {
  target_key_file=$1

  validate_config_key_file_path "$target_key_file"
  target_key_dir=${target_key_file%/*}
  # Prepare the parent dir and reject a non-regular file (e.g. a directory) sitting
  # at the final key path: otherwise `compose cp` would copy the key *inside* it and
  # a later `test -s <directory>` could still pass, leaving the app unable to read it.
  run_app_shell '
    set -eu
    mkdir -p "$1"
    test -d "$1"
    if [ -e "$2" ] && [ ! -f "$2" ]; then
      echo "CONFIG_ENCRYPTION_KEY_FILE target exists and is not a regular file" >&2
      exit 1
    fi
  ' "$target_key_dir" "$target_key_file" \
    || fail "unable to prepare CONFIG_ENCRYPTION_KEY_FILE target on the secrets volume"

  preflight_volume_write_read_delete \
    "$target_key_dir" "CONFIG_ENCRYPTION_KEY_FILE secrets volume"
}

preflight_session_secret_restore_target() {
  target_secret_file=$1

  validate_session_secret_file_path "$target_secret_file"
  target_secret_dir=${target_secret_file%/*}
  run_app_shell '
    set -eu
    mkdir -p "$1"
    test -d "$1"
    if [ -e "$2" ] && [ ! -f "$2" ]; then
      echo "SESSION_SECRET_FILE target exists and is not a regular file" >&2
      exit 1
    fi
  ' "$target_secret_dir" "$target_secret_file" \
    || fail "unable to prepare SESSION_SECRET_FILE target on the secrets volume"

  preflight_volume_write_read_delete \
    "$target_secret_dir" "SESSION_SECRET_FILE secrets volume"
}

verify_container_session_secret_file() {
  target_secret_file=$1
  run_app_shell '
    set -eu
    test -f "$1"
    test ! -L "$1"
    node -e "
      const fs = require(\"fs\");
      const value = fs.readFileSync(process.argv[1], \"utf8\").replace(/\\r?\\n$/, \"\");
      if (!value || value.trim().length === 0 || value === \"change-me\" || value.length < 32) {
        process.exit(1);
      }
    " "$1"
    chmod 600 "$1"
  ' "$target_secret_file"
}

preflight_upload_dir_restore_target() {
  upload_dir=$1

  validate_upload_dir_path "$upload_dir"
  run_app_shell '
    set -eu
    mkdir -p "$1"
    test -d "$1"
  ' "$upload_dir" || fail "unable to prepare UPLOAD_DIR on the uploads volume ($upload_dir)"

  preflight_volume_write_read_delete \
    "$upload_dir" "UPLOAD_DIR uploads volume"
}
