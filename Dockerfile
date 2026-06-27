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
RUN pnpm build && pnpm build:migrator && pnpm build:files-backfill && pnpm build:admin-reset && pnpm build:restore-tools && pnpm build:seed-restore-e2e

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
COPY --from=builder --chown=nextjs:nodejs /app/dist/seed-restore-e2e.mjs ./dist/seed-restore-e2e.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/dedupe-pending-payments.mjs ./scripts/dedupe-pending-payments.mjs
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /app/uploads /app/secrets \
  && chown nextjs:nodejs /app/uploads /app/secrets

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
