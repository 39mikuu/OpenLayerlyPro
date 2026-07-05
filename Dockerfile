# ---- 依赖安装 ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- 构建 ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable pnpm
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build && pnpm build:migrator && pnpm build:files-backfill && pnpm build:admin-reset && pnpm build:restore-tools && pnpm build:seed-restore-e2e && pnpm build:verify-restore-e2e && pnpm build:seed-restore-s3-e2e && pnpm build:inject-restore-s3-drift

# ---- 运行 ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# 迁移 SQL、自包含迁移脚本与管理员恢复脚本
COPY --from=builder --chown=nextjs:nodejs /app/src/db/migrations ./src/db/migrations
COPY --from=builder --chown=nextjs:nodejs /app/dist/migrate.mjs ./dist/migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/files-backfill.mjs ./dist/files-backfill.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/admin-reset.mjs ./dist/admin-reset.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/restore-pre-scan.mjs ./dist/restore-pre-scan.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/restore-neutralize.mjs ./dist/restore-neutralize.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/restore-converge.mjs ./dist/restore-converge.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/restore-schema-check.mjs ./dist/restore-schema-check.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/restore-config-key-probe.mjs ./dist/restore-config-key-probe.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/dedupe-pending-payments.mjs ./scripts/dedupe-pending-payments.mjs
COPY docker/ensure-config-encryption-key.mjs ./docker/ensure-config-encryption-key.mjs
COPY docker/ensure-session-secret.mjs ./docker/ensure-session-secret.mjs
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /app/uploads /app/secrets \
  && chown nextjs:nodejs /app/uploads /app/secrets

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]

# ---- E2E 演练镜像(仅用于备份/恢复演练,含会改数据的测试工具,切勿用于生产) ----
# 生产镜像请构建 `production`(默认)或 `runner` target;本 stage 仅供
# docker-compose.s7-e2e.yml 等演练编排使用(target: e2e-runner)。
FROM runner AS e2e-runner
COPY --from=builder --chown=nextjs:nodejs /app/dist/seed-restore-e2e.mjs ./dist/seed-restore-e2e.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/verify-restore-e2e.mjs ./dist/verify-restore-e2e.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/seed-restore-s3-e2e.mjs ./dist/seed-restore-s3-e2e.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/inject-restore-s3-drift.mjs ./dist/inject-restore-s3-drift.mjs
# Marker that gates destructive E2E-only behaviour (drift injection) in restore.sh.
# It exists ONLY in this image, so the production runner can never run those branches.
RUN touch /app/.e2e-tools && chown nextjs:nodejs /app/.e2e-tools

# ---- 生产运行镜像(默认 / 最后一个 stage)----
# 必须放在 e2e-runner 之后,确保裸 `docker build .`(默认取最后一个 stage)产出的是
# 不含任何测试改数工具、不含 E2E 标记的安全生产镜像。
FROM runner AS production
