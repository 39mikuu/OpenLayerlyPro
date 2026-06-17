# 路线图（Roadmap）

> ✅ 已完成｜▶ 当前阶段｜🚧 计划中。各阶段进入开发时再细化验收标准，本文档不把计划写成已完成。

## Phase 0：MVP 主链路 ✅

已跑通的完整闭环：

- Docker Compose 启动、entrypoint 显式数据库迁移
- 站点初始化（/admin/setup）
- 管理员邮箱 + 密码登录、粉丝邮箱验证码登录（含限流）
- 收款码配置、付款截图上传、后台人工审核、自动开通会员
- 内容三级权限（public / login / member）与会员内容权限下载
- local 存储；local / S3 历史文件按文件记录的 storageDriver 读取与删除
- Cloudflare Tunnel 部署路径

## Phase 1：安全基础 ✅

本阶段交付：

- 正式 PRD 与架构文档定稿（docs/PRD.md、docs/architecture/*）
- Cloudflare Turnstile 保护 `POST /api/auth/request-code`（可选开启，默认关闭；Siteverify 服务端校验 + 调用前 IP 限流）
- 配置加密根密钥：`CONFIG_ENCRYPTION_KEY` / `CONFIG_ENCRYPTION_KEY_FILE`，Docker 首启自动生成并持久化到 secrets volume
- 生产环境禁止默认 / 弱 `SESSION_SECRET`（启动失败）
- 健康检查接口 `GET /api/health`、`GET /api/ready`
- 工程化基线：Prettier + EditorConfig + 强化 ESLint（import 排序、no-explicit-any 告警）、husky + lint-staged + commitlint、vitest 单元测试，CI 接入 format:check 与 test（详见 docs/development/code-style.md）

## Phase 2：配置中心 ✅

把 SMTP、S3/R2、Turnstile、上传限制等配置从 `.env` 迁到后台管理界面。基于 Phase 1 已就绪的加密根密钥逐组交付。

**第一步 ✅（基座，已落地）**：

- **加密能力**：`src/lib/crypto.ts` 的 `encryptSecret` / `decryptSecret`（AES-256-GCM，密钥取自 `getConfigEncryptionKey()`）
- **加密配置表**：`app_settings(key, value_encrypted, updated_at)`，与明文 `site_settings` 分表
- **配置收口层**：`src/modules/config/` 的 `getStoredGroup` / `setStoredGroup` + `getSmtpConfig()`，优先级 DB ＞ 环境变量 ＞ 默认值
- **SMTP 接入**：`src/modules/mail` 改走收口层；`app_settings` 为空时全程回落环境变量，行为零变化
- 详见 [docs/architecture/config-center.md](./architecture/config-center.md)

**第二步 ✅（SMTP 后台 UI，已落地）**：

- 后台「系统配置」页 `/admin/settings` + `/api/admin/config/smtp`（GET/PUT/DELETE）：密码掩码（留空不修改）、「从环境变量导入」、「恢复为环境变量」、复用测试邮件按钮
- `isSmtpConfigured()` 守卫（`login-code`、`payment`、`status`、`test-email`）已统一改走 `getSmtpConfig()`，后台配置在所有路径生效
- 详见 [docs/architecture/config-center.md](./architecture/config-center.md)

**第三步 ✅（Turnstile 后台 UI，已落地）**：

- `/api/admin/config/turnstile` + 系统配置页 Turnstile 卡片，Secret Key 掩码并随配置组加密存储
- 后台 `enabled=false` 可覆盖 env 开启；最终启用时强制要求 Site Key 与 Secret Key
- 登录页 widget 与发码守卫统一读取 DB ＞ env 的最终配置，无需重启

**第四步 ✅（S3/R2 后台 UI，已落地）**：

- `/api/admin/config/storage` + 系统配置页文件存储卡片，支持 local / S3 驱动切换与 S3/R2/MinIO 参数管理
- Access Key ID 与 Secret Access Key 均作为敏感字段加密存储，接口只返回是否已设置
- S3 adapter 不做永久缓存，后台修改后新上传立即使用最终配置；连接测试执行临时对象 Put / Get / Delete 闭环
- 历史文件仍按 `files.storage_driver` 读取和删除；本轮仅支持单 S3 profile

**第五步 ✅（上传限制后台 UI，已落地）**：

- `/api/admin/config/upload` + 系统配置页「上传限制」卡片，管理内容附件上限与付款截图/收款码上限
- 两个上限为非敏感正整数，逐字段 DB ＞ env ＞ 默认；未传字段保留旧值，删除整组回落环境变量
- 消费方 `src/modules/file` 每次校验都读 `getUploadConfig()`，后台修改无需重启即对新上传生效

**后续风险**：

- 配置热更新与进程缓存一致性（当前读时查库；如增加短 TTL 缓存需设计跨进程失效）
- 加密密钥丢失会导致已加密配置不可解密（部署文档已提示备份 secrets volume）

## Phase 3：部署与网络边缘 ✅

**第一步 ✅（可信客户端 IP，已落地）**：

- `getClientIp`（`src/lib/api.ts`）改为只信任已配置代理层：`TRUSTED_PROXY_HOPS`（默认 0，取 `X-Forwarded-For` 右数第 N 个）+ `TRUSTED_PROXY_HEADER`（白名单 enum：x-forwarded-for / x-real-ip / cf-connecting-ip / true-client-ip）
- 默认不信任任何转发头，杜绝伪造；配置跳数超过实际条目数时返回空（失败即安全）
- 按 IP 限流与审计记录（`sessions` / `loginCodes` / `downloadLogs`）据此变为可信
- 详见 [docs/architecture/deployment-network-edge.md](./architecture/deployment-network-edge.md)

**第二步 ✅（VPS + 反代文档与示例，已落地）**：

- 公网 VPS 部署指南 [docs/deploy-vps.md](./deploy-vps.md)：Caddy / Nginx / Traefik 自动 SSL 示例，含锁定 3000 端口、hops=1/2 的 XFF 取值与单值头安全前提
- 内置 `docker-compose.caddy.yml` + `docker/Caddyfile`（Caddy 自动签发并续期 Let's Encrypt 证书）

**第三步 ✅（CDN 接入文档，已落地）**：

- [docs/deploy-cdn.md](./deploy-cdn.md)：CDN 置于反代之前、缓存规则（不缓存 `/api`、`/admin`、下载）、`cf-connecting-ip` 与 hops 取舍及单值头安全前提

## Phase 4：Integration 架构 ▶（进行中）

**第一步 ✅（Integration 注册表 + 统一状态检测，已落地）**：

- 新增 `src/modules/integration/` 的结构化契约与稳定注册表，统一收敛 SMTP、Storage、Turnstile、Tunnel 状态
- 后台系统状态页统一渲染配置完整性、启用状态、配置来源与部署层说明
- 单个集成状态读取失败时降级为 `error`，不影响其余集成和系统状态页
- Tunnel 作为 compose 管理的部署层集成只读纳入；`/api/ready` 继续只检查 Core 必需项

**第二步 ✅（统一连接测试契约，已落地）**：

- `Integration` 描述符新增可选 `test()`；SMTP 复用 `sendTestEmail`、Storage 复用 `testS3Connection`，收敛到统一端点 `POST /api/admin/integrations/[id]/test`
- 新增通用 `IntegrationTestButton`；SMTP 配置/系统状态页与存储配置页的测试入口统一走该端点，删除散装的 `system/test-email` 与 `config/storage/test`
- 未知 id、Turnstile、Tunnel（无 `test()`）一律返回 400「该集成不支持连接测试」；`testableIntegrationIds` 仅表示类型可测试，UI 仍按 `configured` / `driver` 决定显示与启用

**第三步 ✅（`/api/ready` 可选集成探测，已落地）**：

- `/api/ready?integrations=true` 附带各集成的粗粒度探测 `{ id, enabled, healthy }`（`healthy = 未启用或已配置且无 error`），仅信息性
- 默认 `/api/ready` 行为零变化（不查集成、不暴露 driver/source）；集成健康**绝不进入** 200/503 门禁，Core 在集成全关时仍就绪
- 探测失败静默省略 `integrations` 字段，不影响就绪判定

**待续 🚧**：

- 统一启停开关（降级为按需：当前仅 Turnstile 有真正可切换开关且已实现）

## Phase 5：Theme v1 ▶（进行中）

**第一步（试点）✅（契约 + 内置主题标准化 + 解析接缝，已落地）**：

- 新增 `src/modules/theme/`：主题数据契约（SiteChrome / Home / PostList / PostDetail 的 view-model）+ 注册表 + `getActiveTheme()`（读 `site_settings.theme`，回落内置）
- 新增 `src/themes/builtin/`：内置主题作为第一个标准主题，纯按 view-model 渲染；chrome + 首页 + posts（列表/详情）已迁移
- 表现层 / 业务分离：Core（页面）算业务决策与下载 URL，主题只做展示（标签/格式化/布局）；主题不 import Core 业务或 DB

**第二步 ✅（明暗切换 + 字体 + 主题颜色，已落地）**：

- 明暗切换（无新依赖 cookie + class）：`theme_mode` cookie（访客偏好，不入 site_settings）+ 根布局 SSR `.dark` + 极小内联脚本（只读 cookie + matchMedia，防闪烁）+ 站点 `ThemeToggle`（两态，默认跟随系统）
- 字体：`--app-font-sans/--app-font-mono` 源变量映射到 `@theme` 的 `--font-sans/--font-mono`，消除自引用；系统 + CJK 栈，不引外部 webfont
- 主题颜色预设（站点级，存 `site_settings.theme_config`）：具名预设保存 hue，服务端通过 `buildColorPresetCss` 生成**作用域限定**的 `.site-theme` / `.dark .site-theme` 覆盖，SSR 注入、不影响 admin；默认 `neutral` 零覆盖
- 自由取色：后台只提交 `custom` + `[0, 360)` 整数 hue，服务端沿用主题固定 L/C 模板生成整套明/暗 OKLCH 覆盖；不接受任意 CSS 变量或值

**第一步 b ✅（其余 (site) 页面契约化，已落地）**：

- tiers / login / me / me/orders / checkout 五页全部抽到内置主题契约（`Tiers/Login/Me/MeOrders/Checkout` 组件 + view-model），页面瘦身为薄壳；标签映射 / 日期格式化 / 状态展示移入主题；交互件（LoginForm / CheckoutForm / OrderActions）由主题渲染
- 至此**全部公开 (site) 页面表现层 / 业务分离完成**，内置主题为完整契约参考实现

**待续 🚧**：

- 主题切换 UI（后台选活动主题；留到存在第二个主题时再做）

## Phase 6：UI i18n v1 ✅

- UI 多语言框架：最小自研字典（无新依赖）、zh/en、cookie → Accept-Language → 默认 zh 的语言协商、`I18nProvider` / `useT` / `getT`，以及避免客户端引入 `next/headers` 的 client/server split
- 公开站点文案：chrome、首页、作品列表、作品详情、会员、登录、账号、订单、收银台及其交互件均可切换 zh/en
- 后台与初始化界面：`/admin/*`、`/admin/setup`、表单、状态、确认框与通知提示均完成文案抽取
- API 错误本地化：统一稳定 `code` + 结构化 `params`，保留默认中文 `error` 兼容字段；前端按当前 locale 翻译
- 邮件本地化：登录验证码、会员开通、付款驳回与 SMTP 测试邮件支持 zh/en
- 用户语言偏好持久化：`users.locale`、`PUT /api/me/locale`、验证码登录及语言切换后同步；会员开通与付款驳回邮件按收件人语言发送
- 内容数据（作品标题、摘要、正文等）仍保持原文，不属于本阶段

## Phase 7：Content i18n + AI Translation 🚧

按 7·0 → 7·4 串行推进：

- **7·0A Japanese locale foundation ✅**：`SUPPORTED_LOCALES`、类型、cookie / Accept-Language 解析、`users.locale`、`PUT /api/me/locale` 与语言切换器支持 `ja`；默认语言仍为 `zh`
- **7·0B Japanese dictionaries ✅**：公开站点、admin/setup、API 错误与系统邮件的日语字典已补齐，zh/en/ja key 保持同构
- **7·1A Content i18n schema + content module ✅**：`posts.original_locale` + 新表 `post_translations`（**状态版本化** `draft`/`published`/`archived`、`source`、`source_updated_at`、`published_at`；**部分唯一索引 `UNIQUE(post_id, locale) WHERE status='published'`**，不用全量唯一约束）；Core 已提供 `getLocalizedPost`、列表批量本地化与译文 CRUD；发布走事务先归档旧 published 再 promote draft 并填 `published_at`
- **7·1B 前台内容 locale 渲染与回退 ✅**：home / posts / posts/[slug] 按 locale 选择 published 译文，缺失时回落原文；填入现有 view-model，主题零改动；仅 posts，slug 不本地化
- **7·2A 后台译文管理 API ✅**：支持 en/ja 草稿概览与保存、发布、取消发布、删除工作草稿；全部 requireAdmin，校验 locale、标题与正文完整性并返回结构化错误
- **7·2B 后台手动译文 UI ✅**：post 编辑器支持 en/ja 译文草稿保存、发布、撤回和丢弃，并显示未翻译/草稿/已发布/机器生成草稿状态
- **7·3A Translation Integration + provider config ✅**：新增默认关闭的 translation 配置组、加密 API key、OpenAI-compatible provider 抽象和 Integration 状态；本步不生成译文、不调用 provider
- **7·3B AI 译文草稿（创作者控制）**：后台显式触发 provider，生成 `draft(source=machine)`；红线由「默认关闭 + 仅 admin 触发 + 前台只读 published + 不自动发布」保证
- **7·4 审核/发布 + 策略**：草稿审核 → 发布（事务归档旧版）、机翻标注、`source_updated_at` 过期标记、发布策略（草稿待审默认 / 显式开启直接发布）
- 不在范围：SEO/hreflang、archived 保留策略、posts 以外内容（tier 等）的多语言 —— 后续单独评估

详见 [docs/architecture/i18n-ai-translation.md](./architecture/i18n-ai-translation.md)。

## Phase 8：Plugin v0 🚧

- 插件加载机制、生命周期、权限边界的最小可用版本

## Phase 9：Hub official plugin 🚧

- 聚合发现平台以官方插件形式提供，Core 不内置 Hub

## Phase 10：负载均衡与高可用 🚧

- 多实例部署（限流 / 会话等进程内状态外置）
- 基于 `/api/health`、`/api/ready` 的 LB 探活与滚动发布
