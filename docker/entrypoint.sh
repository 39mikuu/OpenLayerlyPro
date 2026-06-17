#!/bin/sh
set -e

UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"
CONFIG_ENCRYPTION_KEY_FILE="${CONFIG_ENCRYPTION_KEY_FILE:-/app/secrets/config-encryption-key}"
export CONFIG_ENCRYPTION_KEY_FILE
SECRETS_DIR="$(dirname "$CONFIG_ENCRYPTION_KEY_FILE")"

# volume 挂载点可能归 root 所有，确保运行用户可写
mkdir -p "$UPLOAD_DIR"

# 配置加密根密钥：未通过 CONFIG_ENCRYPTION_KEY 提供时，首次启动自动生成并持久化到 volume。
# 日志不输出密钥值。
if [ -z "$CONFIG_ENCRYPTION_KEY" ]; then
  mkdir -p "$SECRETS_DIR"
  if [ ! -f "$CONFIG_ENCRYPTION_KEY_FILE" ]; then
    (umask 077 && node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > "$CONFIG_ENCRYPTION_KEY_FILE")
    echo "已生成配置加密密钥文件"
  else
    echo "已加载配置加密密钥文件"
  fi
  chmod 600 "$CONFIG_ENCRYPTION_KEY_FILE"
fi

if [ "$(id -u)" = "0" ]; then
  chown -R nextjs:nodejs "$UPLOAD_DIR"
  if [ -d "$SECRETS_DIR" ]; then
    # 密钥文件必须归运行用户所有且可读
    chown -R nextjs:nodejs "$SECRETS_DIR"
  fi
  # 启动应用前显式执行数据库迁移（失败则退出，不启动应用）
  runuser -u nextjs -- node /app/dist/migrate.mjs
  exec runuser -u nextjs -- "$@"
fi

node /app/dist/migrate.mjs
exec "$@"
