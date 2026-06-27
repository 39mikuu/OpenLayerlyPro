# 开发工作流

## 本地开发

```bash
pnpm install
docker run -d --name ams-postgres -e POSTGRES_DB=artist_member \
  -e POSTGRES_USER=artist -e POSTGRES_PASSWORD=artist_password -p 5432:5432 postgres:16
cp .env.example .env   # DATABASE_URL 改为 localhost；开发环境可保留默认 SESSION_SECRET
pnpm db:migrate
pnpm dev
```

- 开发模式未配置 SMTP 时，验证码输出在服务端控制台。
- `SESSION_SECRET` 强校验只在 `NODE_ENV=production` 运行时生效，不影响开发。
- Turnstile 默认关闭，开发无需配置。

## 校验与构建

```bash
pnpm lint
pnpm format:check
pnpm check:request-bodies
pnpm exec tsc --noEmit
pnpm test
pnpm build:migrator
pnpm build:files-backfill
pnpm build:admin-reset
pnpm build
```

`pnpm build` 只负责 Next 应用；它不会生成恢复/升级需要的 one-off artifact。发布镜像还必须包含：

- `dist/migrate.mjs`；
- `dist/files-backfill.mjs`；
- `dist/admin-reset.mjs`。

当前 Dockerfile 会显式构建并复制三者。当前 CI 已运行 lint、format、request-body、tsc、migration、tests、migrator build 与 Next build；S7 #87 合并前必须把 `build:files-backfill` 纳入 CI 硬门槛，发布验收不能只依赖 Dockerfile 间接覆盖。

涉及 PostgreSQL 并发、约束、任务或支付行为时运行：

```bash
RUN_DB_INTEGRATION_TESTS=true pnpm test
```

若请求体检查失败，请按输出位置改用 `src/lib/request-body.ts` 中的 bounded helper。检查扫描生产 `route.*`，不扫描测试 fixture。

提交前 husky 会对暂存的 `.ts/.tsx` 执行 ESLint/Prettier，commit-msg 使用 commitlint。代码风格与工具链见 [code-style.md](./code-style.md)。

## 数据库迁移约定

开发与生产共用 `scripts/migrate.mjs`：

- 开发：修改 `src/db/schema` → `pnpm drizzle-kit generate` → `pnpm db:migrate`；
- 生产：构建为 `dist/migrate.mjs`，由 entrypoint 在启动应用前执行；失败则 app 不启动。

需要历史数据 remediation 的迁移不能只靠 DDL：必须提供 report/dry-run/apply 流程、停止旧写入的顺序、审计与升级文档。文件安全历史修复由独立 `files-backfill.mjs` 执行，不能假设 migration 或 Next build 会自动完成。

## 环境变量变更约定

新增或修改环境变量时必须同步：

1. `src/lib/env.ts` zod schema（默认值、边界、fail-loud）；
2. `.env.example`；
3. README 关键变量表；
4. 相关 admin/architecture/deployment/release 文档；
5. Docker Compose、CI 和 one-off container 使用点。

涉及 Docker 行为的变更必须保持显式 migration、one-off remediation、失败不启动和可验证 artifact 语义。

## 代码与文档约定

- Route Handler 只做有界读取、认证/授权顺序、解析和响应；业务逻辑放 `src/modules/*`。
- 敏感信息（secret、token、验证码、密钥、原始 provider 错误）不输出日志。
- 活文档区分已实现 / 当前主线 / 后续计划；历史 ADR/handoff 保留当时决策语境。
- 运行时、配置、发布或恢复行为变化时，同一 PR 必须更新对应活文档，避免路线图、README 与运维指南互相矛盾。
- commit message 使用 Conventional Commits 前缀，小步提交。

## Docker 验证

```bash
docker compose up -d --build
docker compose logs app
curl http://localhost:3000/api/health
curl http://localhost:3000/api/ready
```

升级/恢复相关 PR 还必须用独立 Compose project 验证 one-off migrator/backfill、失败路径和正式 app 启动门禁。
