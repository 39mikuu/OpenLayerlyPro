#!/bin/sh
# Shared entrypoint helpers. Sourced by /entrypoint.sh and shell regression tests.

entrypoint_configure_secret_environment() {
  UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"
  CONFIG_ENCRYPTION_KEY_FILE="${CONFIG_ENCRYPTION_KEY_FILE:-/app/secrets/config-encryption-key}"
  export CONFIG_ENCRYPTION_KEY_FILE
  SESSION_SECRET_FILE="${SESSION_SECRET_FILE:-/app/secrets/session-secret}"
  export SESSION_SECRET_FILE
  NOTIFICATION_UNSUBSCRIBE_SECRET_FILE="${NOTIFICATION_UNSUBSCRIBE_SECRET_FILE:-/app/secrets/notification-unsubscribe-secret}"
  export NOTIFICATION_UNSUBSCRIBE_SECRET_FILE
  NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE="${NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE:-/app/secrets/notification-suppression-digest-secret}"
  export NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE
  # Upgraded Compose envs predate the key-id variables; default them so the
  # runtime key-pair validation accepts the generated file-backed secrets
  # (restore already assumes the "current" key id).
  NOTIFICATION_UNSUBSCRIBE_KEY_ID="${NOTIFICATION_UNSUBSCRIBE_KEY_ID:-current}"
  export NOTIFICATION_UNSUBSCRIBE_KEY_ID
  NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID="${NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID:-current}"
  export NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID
  SECRETS_DIR="$(dirname "$CONFIG_ENCRYPTION_KEY_FILE")"
  SESSION_SECRETS_DIR="$(dirname "$SESSION_SECRET_FILE")"
  NOTIFICATION_UNSUBSCRIBE_SECRETS_DIR="$(dirname "$NOTIFICATION_UNSUBSCRIBE_SECRET_FILE")"
  NOTIFICATION_SUPPRESSION_SECRETS_DIR="$(dirname "$NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE")"
}

entrypoint_provision_secrets() {
  # volume 挂载点可能归 root 所有，确保运行用户可写
  mkdir -p "$UPLOAD_DIR"

  # 配置加密根密钥：环境变量优先；否则由独占、原子发布流程首次生成并持久化。
  # 已存在但非法的文件会失败，不会被替换。日志不输出密钥值。
  node /app/docker/ensure-config-encryption-key.mjs "$CONFIG_ENCRYPTION_KEY_FILE"

  # 会话密钥：环境变量优先；否则由独占、原子发布流程首次生成并持久化。
  # 已存在但非法的文件会失败，不会被替换。
  node /app/docker/ensure-session-secret.mjs "$SESSION_SECRET_FILE"

  # 通知退订与抑制摘要密钥：当前密钥支持 Compose 首启生成并持久化；
  # previous key 永远不自动生成，必须由运维显式配置。
  node /app/docker/ensure-notification-secret.mjs \
    "$NOTIFICATION_UNSUBSCRIBE_SECRET_FILE" \
    NOTIFICATION_UNSUBSCRIBE_SECRET \
    NOTIFICATION_UNSUBSCRIBE_SECRET
  node /app/docker/ensure-notification-secret.mjs \
    "$NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE" \
    NOTIFICATION_SUPPRESSION_DIGEST_SECRET \
    NOTIFICATION_SUPPRESSION_DIGEST_SECRET
}

entrypoint_chown_regular_file_or_fail() {
  target=$1
  label=$2

  if [ -L "$target" ]; then
    echo "$label must not be a symlink" >&2
    return 1
  fi
  if [ -f "$target" ]; then
    # The symlink check above gives a clear honest-path diagnostic; chown -h is the
    # race-safety mechanism, so a swapped-in symlink re-owns only the link itself.
    chown -h nextjs:nodejs "$target"
  fi
}

entrypoint_apply_root_ownership() {
  chown -R nextjs:nodejs "$UPLOAD_DIR"

  config_file_mode=false
  if [ -z "${CONFIG_ENCRYPTION_KEY:-}" ]; then
    config_file_mode=true
  fi

  session_file_mode=false
  if [ -z "${SESSION_SECRET:-}" ]; then
    session_file_mode=true
  fi

  unsubscribe_file_mode=false
  if [ -z "${NOTIFICATION_UNSUBSCRIBE_SECRET:-}" ]; then
    unsubscribe_file_mode=true
  fi

  suppression_file_mode=false
  if [ -z "${NOTIFICATION_SUPPRESSION_DIGEST_SECRET:-}" ]; then
    suppression_file_mode=true
  fi

  # In CONFIG_ENCRYPTION_KEY env mode, the config key file path is not touched at all:
  # no file tests, chmod, or chown. Still chown the shared secrets dir when the
  # file-backed SESSION_SECRET lives there, because the default session-secret path is
  # /app/secrets/session-secret and needs the directory writable by nextjs.
  if [ -d "$SECRETS_DIR" ] && {
    [ "$config_file_mode" = true ] || {
      { [ "$session_file_mode" = true ] && [ "$SESSION_SECRETS_DIR" = "$SECRETS_DIR" ]; } || \
      { [ "$unsubscribe_file_mode" = true ] && [ "$NOTIFICATION_UNSUBSCRIBE_SECRETS_DIR" = "$SECRETS_DIR" ]; } || \
      { [ "$suppression_file_mode" = true ] && [ "$NOTIFICATION_SUPPRESSION_SECRETS_DIR" = "$SECRETS_DIR" ]; }
    }
  }; then
    chown nextjs:nodejs "$SECRETS_DIR"
  fi

  for notification_secret_dir in \
    "$SESSION_SECRETS_DIR" \
    "$NOTIFICATION_UNSUBSCRIBE_SECRETS_DIR" \
    "$NOTIFICATION_SUPPRESSION_SECRETS_DIR"
  do
    if [ "$notification_secret_dir" != "$SECRETS_DIR" ] && [ -d "$notification_secret_dir" ]; then
      chown nextjs:nodejs "$notification_secret_dir"
    fi
  done

  if [ "$config_file_mode" = true ]; then
    entrypoint_chown_regular_file_or_fail \
      "$CONFIG_ENCRYPTION_KEY_FILE" "CONFIG_ENCRYPTION_KEY_FILE" \
      || return 1
  fi

  if [ "$session_file_mode" = true ]; then
    entrypoint_chown_regular_file_or_fail "$SESSION_SECRET_FILE" "SESSION_SECRET_FILE" \
      || return 1
  fi

  if [ "$unsubscribe_file_mode" = true ]; then
    entrypoint_chown_regular_file_or_fail \
      "$NOTIFICATION_UNSUBSCRIBE_SECRET_FILE" "NOTIFICATION_UNSUBSCRIBE_SECRET_FILE" \
      || return 1
  fi

  if [ "$suppression_file_mode" = true ]; then
    entrypoint_chown_regular_file_or_fail \
      "$NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE" "NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE" \
      || return 1
  fi
}
