# OpenLayerlyPro 产品需求文档（PRD）

> 状态标注约定：✅ 已实现（当前代码可用）｜▶ 当前发布主线｜🚧 后续计划。本文档描述当前 `main`；历史实现过程见 ADR/handoff，发布门槛见 `release-v1.0-checklist.md`。

## 1. 项目定位

OpenLayerlyPro 是一个**开源、自托管、面向画师/创作者的单站会员作品系统**。

- 单创作者站点：一套部署服务一位创作者（或一个创作团队），数据完全归创作者所有。✅
- 自托管优先：Docker Compose 部署，支持家庭服务器 + Cloudflare Tunnel，也支持公网 VPS、Caddy/Nginx/Traefik 与 CDN。✅
- 商业闭环：粉丝付费 → 人工审核或签名 provider event → 开通对应会员期 → 按权限浏览/下载；支持人工付款、Stripe 一次性 Checkout、Stripe 自动订阅与手动续费提醒。✅
- 不做平台：不做多创作者入驻、不做内容广场。Hub / 聚合发现暂不规划；如未来需要，应作为独立产品方向重新评估，不进入 Core。⏸

当前发布状态：v1.0.0 已发布（tag `v1.0.0`）。S1a/S1b/S2/S3/S4/S5/S6/S7、订阅与验收后硬化线均已实现；最终验收 #88 已在最终 release build 上完成。✅

## 2. 用户角色

| 角色 | 说明 | 登录方式 |
|---|---|---|
| 创作者 / 管理员 | 管理内容、会员等级、付款/订阅、文件、系统配置与运维状态 | 邮箱 + 密码 ✅ |
| 粉丝 / 会员 | 购买/订阅会员、管理提醒偏好、按权限浏览与下载内容 | 邮箱验证码 ✅ |
| 访客 | 未登录用户，仅可浏览 public 内容 | 无 ✅ |

## 3. Core 单站系统

Core 是系统的不可拆卸核心，负责：

- **会员**：等级、按笔时间窗、active/suspended/revoked 生命周期、并发串行授予与按付款期反转。✅
- **内容**：作品发布、定时发布、public/login/member 权限、分类/标签、Markdown、内联图片/视频与多语言版本。✅
- **文件**：有界上传、服务端权威 MIME、图片重编码/quarantine、local/S3 双驱动、Range 播放、完整引用检查与两阶段删除。✅
- **下载鉴权**：所有私有下载逐请求鉴权与日志；公开 S3 资源只在真实公开授权路径下使用短时/有界签名 URL。✅
- **付款与订阅**：人工凭证审核、Stripe 一次性 Checkout、Stripe 自动订阅、手动周期提醒、provider-event inbox/dispatcher、退款/拒付/reconcile。✅
- **Session / Auth**：HMAC 会话、管理员账号维护、粉丝高熵验证码、Turnstile、可信 IP 与 S4 限流。✅
- **配置中心**：`app_settings` 加密配置、后台 SMTP/Turnstile/S3/上传/Stripe/Translation 管理；按各组契约支持 DB、环境变量与默认值。✅
- **审计与任务**：统一 `audit_events` 因果链、`app_events` 运维事件、durable task/outbox、lease/fencing、有界重试与后台重试视图。✅

Core 边界原则：

1. 所有可选集成关闭时，人工付款与本地 Core 仍能运行。
2. 权限、付款、会员和文件生命周期规则只存在于 Core，不下沉到 Theme 或外部扩展。
3. 第三方失败不能绕过审计、事务、幂等或下载鉴权。
4. 详见 [architecture/core-system.md](architecture/core-system.md)。

## 4. Theme 主题系统 ▶

- Theme 只负责表现层，不负责业务逻辑，不直接访问数据库。
- 全部公开站点页面已通过 Core view-model 契约由内置主题渲染；明暗模式、字体、颜色预设和安全自由 hue 已实现。✅
- 第二主题（博客主题：文字优先阅读形态，交易页复用内置实现）与后台活动主题选择器已实现；各主题配色按主题分键独立保存。✅
- 详见 [architecture/theme-system.md](architecture/theme-system.md)。

## 5. Integration 集成系统

Integration 是官方内置的第三方服务对接，随 Core 发布、由项目维护。

当前集成：

- SMTP 邮件 ✅
- local / S3 / R2 / MinIO 存储 ✅
- Cloudflare Turnstile ✅
- Cloudflare Tunnel（部署层）✅
- Stripe 支付与订阅 ✅
- OpenAI-compatible Translation provider ✅

统一注册表、结构化状态、连接测试和 `/api/ready?integrations=true` 信息性探测已实现。并非所有集成都需要通用启停开关；当前按各自配置契约控制。详见 [architecture/integration-plugin-system.md](architecture/integration-plugin-system.md)。

## 6. 扩展策略

- 不规划通用第三方 Plugin runtime。插件加载、生命周期、权限模型、故障隔离、版本兼容和安全审计会显著增加项目难度，不符合当前单创作者自托管产品主线。
- 后续扩展优先通过官方内置能力交付：Theme、Integration、邮件、SEO、统计、内容组织和运营工具都随 Core 版本一起维护。
- Core Auth 后续可增加邮件 Magic Link、Google OAuth 与 GitHub OAuth，作为粉丝登录补充入口；现有邮箱验证码登录保留为 fallback，管理员登录第一版不切换到第三方 OAuth。
- Membership Bundle 可作为会员等级权益表达增强单独推进；Tips、PPV 等支付型新商业能力继续保留为产品定义和运营验证项。
- Hub / 聚合发现暂不规划。未来如真实运营证明需要跨站发现，应作为独立产品方向重新评估，不进入 Core。

## 7. i18n + AI Translation ✅

- UI、后台、初始化、API 错误与系统邮件支持 zh/en/ja；语言按 cookie → Accept-Language → 默认 zh 协商。
- 用户语言偏好持久化到 `users.locale`，异步邮件按收件人偏好发送。
- `posts.original_locale` + 版本化 `post_translations` 支持 draft/published/archived、manual/machine、published 唯一约束与原文回落。
- 后台支持手动译文 CRUD、预览/审核/发布/撤回和 stale-source 提示。
- OpenAI-compatible AI 翻译默认关闭，仅管理员显式触发；默认保存 machine draft，direct publish 必须创作者显式开启，访客不能触发成本。
- SEO/hreflang、posts 之外的内容翻译和 archived 历史恢复仍属后续。
- 详见 [architecture/i18n-ai-translation.md](architecture/i18n-ai-translation.md)。

## 8. Deployment & Network Edge

- App 仅监听 HTTP；TLS 由 Cloudflare Tunnel、Caddy、Nginx、Traefik 或 CDN 终止。✅
- `/api/health` 与 `/api/ready` 已实现；可选 integrations 摘要不进入就绪门禁。✅
- 可信代理 IP 解析、VPS/反代、CDN 和 Cloudflare Tunnel 文档与示例已实现。✅
- 单实例是 v1.0 运行边界；Redis/PG 共享 limiter、多实例滚动发布与高可用属于 Phase 10。🚧
- S6 全局响应头/CSP 运行时实现是 #86。✅
- S7 archive integrity、schema probe、恢复任务中和与 DB↔存储收敛是 #87。✅

## 9. 安全需求

| 需求 | 状态 |
|---|---|
| 生产环境禁止默认 / 弱 `SESSION_SECRET` | ✅ |
| 可信代理真实 IP 与 operation-specific unresolved emergency bucket | ✅ |
| S4 正确码优先、错误后限流、source-scoped pre-compare budget | ✅ |
| 高熵 Crockford login code、keyed email identity、加密 durable delivery task | ✅ |
| Turnstile 与调用前保护 | ✅ |
| 全生产 Route Handler 请求体有界读取 | ✅ |
| 配置加密根密钥与敏感配置加密存储 | ✅ |
| 统一审计因果链与 durable outbox/fencing | ✅ |
| 上传服务端权威 MIME、强制 raster 重编码与文件响应隔离 | ✅ |
| 完整文件引用检查、两阶段删除与付款凭证生命周期 | ✅ |
| SMTP defer/dead、稳定 Message-ID、delivery ledger 与后台重发 | ✅ |
| nonce CSP 与全局安全响应头、legacy footer 安全迁移 | ✅ #86 |
| archive v2/checksum、v1 schema probe、恢复中和与存储收敛 | ✅ #87 |
| 多实例共享限流/任务协调 | 🚧（不纳入 v1.0） |

## 10. 配置中心 ✅

- SMTP、Turnstile、Storage、Upload 使用 DB ＞ env ＞ default 的最终配置语义；删除 DB 组可回落环境变量。
- Stripe 与 Translation 使用后台加密配置，默认关闭，敏感 key 不返回前端。
- 配置读取当前按需查库，修改后无需重启；如果未来增加缓存，必须设计跨进程 revision/失效策略。
- 配置加密根密钥和 `SESSION_SECRET` 是不同秘密，备份/恢复语义分别记录。

## 11. 路线图摘要

已完成：MVP → 安全基础 → 配置中心 → 网络边缘 → Integration 基座 → Theme v1 基座 → UI i18n → Content i18n/AI → v1 Core hardening → 自动支付/订阅/文件能力 → S1a–S7 → v1.0 最终验收与发布 #88 → 发布后审计硬化。

当前：v1.1「不只画师」继续提高产品完成度；WP1 已完成，WP2–WP6 按计划书里程碑串行推进，不再等待固定发布后窗口。

后续：v1.1 WP2–WP6 → Phase 8 运营完成度与官方内置能力 → 多实例负载均衡与高可用。（Hub / 聚合发现暂不规划。）

完整内容见 [roadmap.md](roadmap.md)。

## 12. v1.0 验收原则

1. handoff 或代码合并不等于发布完成。
2. S6 必须在真实浏览器中验证 nonce、Turnstile、S3、视频、integration 与 legacy footer rollout。
3. S7 必须在独立 Compose 项目中验证 archive integrity、旧 schema、mandatory file-safety backfill、任务/支付事件恢复和 local/S3 收敛。
4. Stripe Test Mode、人工付款、订阅、退款/拒付、并发 grant、SMTP 失败矩阵、文件权限与升级路径必须完成真实环境抽样。
5. 完整 CI、浏览器 E2E、恢复 E2E 和安全告警检查全绿后才创建 `v1.0.0`。
6. 权威清单见 [release-v1.0-checklist.md](release-v1.0-checklist.md)。
