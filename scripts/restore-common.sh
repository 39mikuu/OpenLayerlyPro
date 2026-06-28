#!/bin/sh
# shellcheck disable=SC2016 # Expand Compose service variables inside the container shell.
# Shared helpers for backup.sh and restore.sh (sourced, not executed directly).

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

canonicalize_container_path() {
  raw_path=$1
  label=$2

  validate_absolute_container_path "$raw_path" "$label"
  validate_no_path_traversal "$raw_path" "$label"

  canonical_path=$(
    compose run --rm -T --no-deps --entrypoint sh app -c "
      set -eu
      if command -v realpath >/dev/null 2>&1; then
        realpath -m -- '$raw_path'
      else
        printf '%s\n' '$raw_path'
      fi
    " | tr -d '\r'
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

preflight_config_key_restore_target() {
  target_key_file=$1

  validate_config_key_file_path "$target_key_file"
  target_key_dir=${target_key_file%/*}
  compose run --rm -T --no-deps --entrypoint sh app -c "
    set -eu
    mkdir -p \"$target_key_dir\"
    test -d \"$target_key_dir\"
  " || fail "unable to prepare CONFIG_ENCRYPTION_KEY_FILE directory on target volume"
}