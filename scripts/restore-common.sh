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

manifest_value_or_default() {
  manifest_path=$1
  key=$2
  default_value=$3
  value=$(grep "^${key}=" "$manifest_path" | cut -d= -f2- | tr -d '\r' || true)
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    printf '%s' "$default_value"
  fi
}

sha256_trimmed_file() {
  file_path=$1
  node -e '
    const { createHash } = require("crypto");
    const { readFileSync } = require("fs");
    process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1], "utf8").trim()).digest("hex"));
  ' "$file_path"
}

inspect_app_container_provenance() {
  container_id=$1

  docker_cmd inspect --format '{{json .Config.Env}} {{json .Image}}' "$container_id" \
    | node -e '
      const input = require("fs").readFileSync(0, "utf8").trim();
      const separator = input.lastIndexOf(" ");
      if (separator < 0) process.exit(1);
      const envList = JSON.parse(input.slice(0, separator));
      const imageId = JSON.parse(input.slice(separator + 1));
      const env = new Map();
      for (const entry of Array.isArray(envList) ? envList : []) {
        const index = entry.indexOf("=");
        if (index > 0) env.set(entry.slice(0, index), entry.slice(index + 1));
      }
      const value = (name) => {
        const resolved = env.get(name);
        return resolved && resolved.length > 0 ? resolved : "unknown";
      };
      process.stdout.write(
        JSON.stringify({
          appVersion: value("APP_VERSION"),
          sourceCommit: value("SOURCE_COMMIT"),
          buildTimestamp: value("BUILD_TIMESTAMP"),
          imageId: imageId && imageId.length > 0 ? imageId : "unknown",
        }),
      );
    '
}

resolve_single_app_container_id() {
  compose create app >/dev/null
  container_ids=$(compose ps -aq app)
  [ -n "$container_ids" ] || fail "unable to resolve app service container for image provenance"

  container_count=$(printf '%s\n' "$container_ids" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$container_count" = "1" ] \
    || fail "multiple app service containers found; remove stale containers or scale to 1 before backup/restore"

  printf '%s' "$container_ids"
}

read_app_container_provenance() {
  container_id=$1
  provenance_json=$(inspect_app_container_provenance "$container_id") \
    || fail "unable to inspect app service image provenance"

  RUNTIME_APP_VERSION=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).appVersion)' "$provenance_json")
  RUNTIME_SOURCE_COMMIT=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sourceCommit)' "$provenance_json")
  BUILD_TIMESTAMP=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).buildTimestamp)' "$provenance_json")
  RUNTIME_IMAGE_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).imageId)' "$provenance_json")
  : "$RUNTIME_APP_VERSION" "$RUNTIME_SOURCE_COMMIT" "$BUILD_TIMESTAMP" "$RUNTIME_IMAGE_ID"
}

read_archive_provenance() {
  manifest_path=$1

  ARCHIVE_RUNTIME_APP_VERSION=$(manifest_value_or_default "$manifest_path" RUNTIME_APP_VERSION "$(manifest_value_or_default "$manifest_path" APP_VERSION "unknown")")
  ARCHIVE_RUNTIME_SOURCE_COMMIT=$(manifest_value_or_default "$manifest_path" RUNTIME_SOURCE_COMMIT "unknown")
  ARCHIVE_RUNTIME_IMAGE_ID=$(manifest_value_or_default "$manifest_path" RUNTIME_IMAGE_ID "unknown")
  ARCHIVE_BUILD_TIMESTAMP=$(manifest_value_or_default "$manifest_path" BUILD_TIMESTAMP "unknown")
  ARCHIVE_BACKUP_TOOL_COMMIT=$(manifest_value_or_default "$manifest_path" BACKUP_TOOL_COMMIT "unknown")
  ARCHIVE_BACKUP_TOOL_SCRIPT_SHA256=$(manifest_value_or_default "$manifest_path" BACKUP_TOOL_SCRIPT_SHA256 "unknown")
  : "$ARCHIVE_RUNTIME_APP_VERSION" "$ARCHIVE_RUNTIME_SOURCE_COMMIT" "$ARCHIVE_RUNTIME_IMAGE_ID" \
    "$ARCHIVE_BUILD_TIMESTAMP" "$ARCHIVE_BACKUP_TOOL_COMMIT" "$ARCHIVE_BACKUP_TOOL_SCRIPT_SHA256"
}

warn_legacy_provenance_if_needed() {
  format_version=$1
  case "$format_version" in
    1|2)
      echo "WARNING: FORMAT_VERSION=$format_version archive predates image-authoritative backup provenance; runtime version/commit/image identity may be unavailable or host-derived" >&2
      ;;
  esac
}

verify_archive_config_key_fingerprint() {
  payload_dir=$1
  format_version=$2

  if [ "$format_version" = "3" ]; then
    expected_config_encryption_key_sha256=$(manifest_value "$payload_dir/manifest.env" CONFIG_ENCRYPTION_KEY_SHA256)
    actual_config_encryption_key_sha256=$(sha256_trimmed_file "$payload_dir/secrets/config-encryption-key") \
      || fail "unable to fingerprint archived config encryption key"
    [ "$actual_config_encryption_key_sha256" = "$expected_config_encryption_key_sha256" ] \
      || fail "archived config encryption key does not match manifest CONFIG_ENCRYPTION_KEY_SHA256"
  else
    echo "WARNING: FORMAT_VERSION=$format_version archive has no CONFIG_ENCRYPTION_KEY_SHA256 fingerprint; relying on decrypt probe only" >&2
  fi
}

warn_if_mismatch() {
  label=$1
  archive_value=$2
  target_value=$3

  if [ "$archive_value" != "unknown" ] && [ "$archive_value" != "$target_value" ]; then
    echo "WARNING: archive $label ($archive_value) differs from target $label ($target_value); migration identity remains the hard compatibility gate" >&2
  fi
}

extract_app_settings_copy_block() {
  dump_path=$1
  output_path=$2

  awk '
    /^COPY public\.app_settings[[:space:]]*\(/ {
      in_block = 1
      found = 1
      print
      next
    }
    in_block {
      print
      if ($0 == "\\.") {
        in_block = 0
      }
      next
    }
    END {
      if (in_block) exit 2
      if (!found) exit 1
    }
  ' "$dump_path" > "$output_path"
}

app_settings_copy_block_has_rows() {
  copy_path=$1

  awk '
    /^COPY public\.app_settings[[:space:]]*\(/ {
      in_block = 1
      next
    }
    in_block && $0 == "\\." {
      exit rows ? 0 : 1
    }
    in_block {
      rows = 1
    }
    END {
      exit rows ? 0 : 1
    }
  ' "$copy_path"
}

app_settings_scratch_create_table_sql() {
  copy_path=$1

  awk '
    function fail(message) {
      print message > "/dev/stderr"
      exit 1
    }
    /^COPY public\.app_settings[[:space:]]*\(/ {
      header = $0
      sub(/^COPY public\.app_settings[[:space:]]*\(/, "", header)
      sub(/\)[[:space:]]+FROM stdin;[[:space:]]*$/, "", header)
      if (header == $0) fail("archive app_settings COPY header is malformed")
      count = split(header, raw_columns, /,[[:space:]]*/)
      if (count < 1) fail("archive app_settings has no columns")

      sql = "create table public.app_settings ("
      has_key = 0
      has_value_encrypted = 0
      for (i = 1; i <= count; i++) {
        column = raw_columns[i]
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", column)
        if (column !~ /^[a-z_][a-z0-9_]*$/) {
          fail("archive app_settings contains unsupported column identifier")
        }
        if (column == "key") has_key = 1
        if (column == "value_encrypted") has_value_encrypted = 1
        sql = sql (i == 1 ? "" : ", ") column " text"
      }
      if (!has_key) fail("archive app_settings has no key column")
      if (!has_value_encrypted) fail("archive app_settings has no value_encrypted column")
      print sql ")"
      found = 1
      exit 0
    }
    END {
      if (!found) exit 1
    }
  ' "$copy_path"
}

# Validate the archive's storage payload and its v2/v3 semantic contract before any
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

  case "$format_version" in
    2|3) ;;
    *) return 0 ;;
  esac
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
    if [ -L "$2" ] || { [ -e "$2" ] && [ ! -f "$2" ]; }; then
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
    if [ -L "$2" ] || { [ -e "$2" ] && [ ! -f "$2" ]; }; then
      echo "SESSION_SECRET_FILE target exists and is not a regular file" >&2
      exit 1
    fi
  ' "$target_secret_dir" "$target_secret_file" \
    || fail "unable to prepare SESSION_SECRET_FILE target on the secrets volume"

  preflight_volume_write_read_delete \
    "$target_secret_dir" "SESSION_SECRET_FILE secrets volume"
}

# Validate that a SESSION_SECRET provided through the target app environment is explicit
# and strong, using the exact same rule as the runtime resolver, the backup fingerprint
# capture, and the file/external archive branches: present, non-blank after trim, not the
# `change-me` placeholder, and at least 32 characters. Runs in a one-off app container and
# never prints the secret. Returns non-zero when the value is missing or weak; callers must
# treat that as a hard, pre-destructive restore failure.
require_strong_env_session_secret() {
  compose run --rm -T --no-deps --entrypoint node app -e '
    const value = process.env.SESSION_SECRET;
    if (!value || value.trim().length === 0 || value === "change-me" || value.length < 32) {
      process.exit(1);
    }
  '
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
