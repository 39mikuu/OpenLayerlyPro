#!/bin/sh
set -e

. /entrypoint-secrets.sh

entrypoint_configure_secret_environment
entrypoint_provision_secrets

if [ "$(id -u)" = "0" ]; then
  entrypoint_apply_root_ownership
  # 启动应用前显式执行数据库迁移（失败则退出，不启动应用）
  runuser -u nextjs -- node /app/dist/migrate.mjs
  exec runuser -u nextjs -- "$@"
fi

node /app/dist/migrate.mjs
exec "$@"
