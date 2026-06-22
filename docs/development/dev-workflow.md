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
- Turnstile 默认关闭（`TURNSTILE_ENABLED=false`），开发无需配置。

## 校验与构建

```bash
pnpm lint           # ESLint（含 import 排序、no-explicit-any 告警）
pnpm format         # Prettier 写入；pnpm format:check 只检查不改
pnpm check:request-bodies # 检查生产 Route Handler 的请求体读取
pnpm test           # vitest 运行单元测试；pnpm test:watch 监听模式
pnpm exec tsc --noEmit   # 类型检查
pnpm build          # next build
```

CI（.github/workflows/ci.yml）执行 lint → format:check → check:request-bodies → tsc → test → build:migrator → build。

若请求体检查失败，请按输出的文件和行号改用 `src/lib/request-body.ts` 中的 bounded helper。检查仅扫描生产 `route.*` 文件，不扫描测试 fixture。

提交前 husky 的 `pre-commit` 会对暂存的 `.ts/.tsx` 自动跑 `eslint --fix` + `prettier --write`，`commit-msg` 用 commitlint 校验提交信息格式。代码风格与工具链细节见 [code-style.md](./code-style.md)。

## 数据库迁移约定

开发与生产共用 `scripts/migrate.mjs`：

- 开发：修改 `src/db/schema` → `pnpm drizzle-kit generate` → `pnpm db:migrate`
- 生产：构建时打包为 `dist/migrate.mjs`，由 `docker/entrypoint.sh` 在启动应用前显式执行，失败则容器不启动。应用运行时不做迁移。

## 环境变量变更约定

新增或修改环境变量时**必须同步**：

1. `src/lib/env.ts` 的 zod schema（含默认值与校验规则）
2. `.env.example`（含注释说明）
3. README 环境变量表（关键项）与相关文档

涉及 Docker 行为的变更（entrypoint / compose / Dockerfile）必须保证现有迁移流程与 `docker compose up -d` 启动方式不被破坏。

## 代码约定

- API route 只做解析与响应，业务逻辑放 `src/modules/*`；错误用 `ApiError` + `handleApiError`。
- 敏感信息（secret、token、验证码、密钥）不输出日志。
- 文档区分「已实现 ✅ / 计划中 🚧」，不把计划写成已完成。
- commit message 使用 Conventional Commits 前缀 + 中文描述（如 `feat(config): 新增 SMTP 后台配置项`），小步提交。

## Docker 验证

```bash
docker compose up -d --build
docker compose logs app          # 应看到迁移成功 +「已生成/已加载配置加密密钥文件」
curl http://localhost:3000/api/health   # 200
curl http://localhost:3000/api/ready    # 200（数据库正常时）
```
