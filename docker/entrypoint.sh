#!/bin/sh
set -e

UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"
CONFIG_ENCRYPTION_KEY_FILE="${CONFIG_ENCRYPTION_KEY_FILE:-/app/secrets/config-encryption-key}"
export CONFIG_ENCRYPTION_KEY_FILE
SESSION_SECRET_FILE="${SESSION_SECRET_FILE:-/app/secrets/session-secret}"
export SESSION_SECRET_FILE
SECRETS_DIR="$(dirname "$CONFIG_ENCRYPTION_KEY_FILE")"
SESSION_SECRETS_DIR="$(dirname "$SESSION_SECRET_FILE")"

# volume 挂载点可能归 root 所有，确保运行用户可写
mkdir -p "$UPLOAD_DIR"

# 配置加密根密钥：环境变量优先；否则由独占、原子发布流程首次生成并持久化。
# 已存在但非法的文件会失败，不会被替换。日志不输出密钥值。
node /app/docker/ensure-config-encryption-key.mjs "$CONFIG_ENCRYPTION_KEY_FILE"

# 会话密钥：环境变量优先；否则由独占、原子发布流程首次生成并持久化。
# 已存在但非法的文件会失败，不会被替换。
node /app/docker/ensure-session-secret.mjs "$SESSION_SECRET_FILE"

if [ "$(id -u)" = "0" ]; then
  chown -R nextjs:nodejs "$UPLOAD_DIR"
  if [ -d "$SECRETS_DIR" ]; then
    chown nextjs:nodejs "$SECRETS_DIR"
    if [ -f "$CONFIG_ENCRYPTION_KEY_FILE" ]; then
      chown nextjs:nodejs "$CONFIG_ENCRYPTION_KEY_FILE"
    fi
  fi
  if [ "$SESSION_SECRETS_DIR" != "$SECRETS_DIR" ] && [ -d "$SESSION_SECRETS_DIR" ]; then
    chown nextjs:nodejs "$SESSION_SECRETS_DIR"
  fi
  if [ -z "${SESSION_SECRET:-}" ] && [ -f "$SESSION_SECRET_FILE" ]; then
    chown nextjs:nodejs "$SESSION_SECRET_FILE"
  fi
  # 启动应用前显式执行数据库迁移（失败则退出，不启动应用）
  runuser -u nextjs -- node /app/dist/migrate.mjs
  exec runuser -u nextjs -- "$@"
fi

node /app/dist/migrate.mjs
exec "$@"
