# OpenLayerlyPro 产品需求文档（PRD）

> 状态标注约定：✅ 已实现（当前代码可用）｜🚧 计划中（尚未实现，仅为设计方向）。
> 本文档刻意区分两者，未标注 ✅ 的能力一律视为计划。

## 1. 项目定位

OpenLayerlyPro 是一个**开源、自托管、面向画师/创作者的会员作品站系统**。

- 单创作者站点：一套部署服务一位创作者（或一个创作团队），数据完全归创作者所有。
- 自托管优先：Docker Compose 一键部署，支持家庭服务器 + Cloudflare Tunnel（无公网 IP）。✅
- 核心商业闭环：粉丝付费 → 人工审核 → 自动开通会员 → 按权限下载内容。✅
- 不做平台：不做多创作者入驻、不做内容广场。聚合发现（Hub）未来以官方插件形式提供，不进入 Core。🚧

## 2. 用户角色

| 角色 | 说明 | 登录方式 |
|---|---|---|
| 创作者 / 管理员 | 站点所有者，管理内容、会员等级、付款审核、系统配置 | 邮箱 + 密码 ✅ |
| 粉丝 / 会员 | 购买会员、按权限浏览与下载内容 | 邮箱验证码 ✅ |
| 访客 | 未登录用户，仅可浏览 public 内容 | 无 ✅ |

## 3. Core 单站系统

Core 是系统的不可拆卸核心，负责：

- **会员**：会员等级、会员有效期、自动开通 ✅
- **内容**：作品发布、public / login / member 三级可见性 ✅
- **文件**：上传、local / S3 双驱动存储、按文件记录的 storageDriver 读取与删除 ✅
- **下载鉴权**：所有下载经过权限校验与日志记录，S3 走短时签名 URL ✅
- **付款审核**：收款码配置、付款截图上传、人工审核 ✅
- **Session**：基于 HMAC 的会话管理 ✅
- **配置加密**：配置加密根密钥的生成 / 持久化 / 读取 ✅；加密配置表与配置中心 🚧
- **审计**：应用事件记录（登录、审核等）✅；完整审计日志体系 🚧

Core 边界原则：

1. Core 不依赖任何主题、集成或插件即可独立完成主闭环。
2. 业务规则（权限、审核、会员状态）只存在于 Core，不允许下沉到表现层或外部扩展。
3. 详见 [architecture/core-system.md](architecture/core-system.md)。

## 4. Theme 主题系统 ▶（进行中）

- Theme 只负责表现层（页面布局、样式、组件渲染），**不负责业务逻辑**。
- 主题通过 Core 提供的数据契约渲染，不直接访问数据库。
- Phase 5 进行中：主题数据契约 + 内置主题标准化（全部 (site) 页面）+ 明暗切换 + 字体 + 主题颜色预设与自由取色（hue + 服务端模板）✅；主题切换 UI 留到存在第二个主题时再做。机制详见 [architecture/theme-system.md](architecture/theme-system.md)。

## 5. Integration 集成系统

- Integration 是**官方内置**的第三方服务对接（如对象存储、邮件服务、统计），随 Core 发布、由官方维护。
- 当前集成：SMTP 邮件 ✅、S3/R2 对象存储 ✅、Cloudflare Turnstile ✅、Cloudflare Tunnel ✅。
- 统一抽象推进中：Integration 注册表、结构化状态检测、统一连接测试契约、`/api/ready` 可选集成探测 ✅；统一启停开关 🚧。
- 详见 [architecture/integration-plugin-system.md](architecture/integration-plugin-system.md)。

## 6. Plugin 插件系统 🚧

- Plugin 是后期的第三方扩展机制，允许社区在不修改 Core 的前提下扩展功能。
- Hub 聚合发现平台未来作为**官方插件**实现，不进入 Core。
- 详见 [architecture/integration-plugin-system.md](architecture/integration-plugin-system.md)。

## 7. i18n + AI Translation

- **Phase 6：UI i18n v1 ✅**。公开站点、后台与初始化界面已完成 zh/en 界面多语言；语言通过 cookie → Accept-Language → 默认 zh 协商。
- 面向前台的 API 错误已使用稳定 `code` + 结构化 `params` 本地化，并保留默认中文 `error` 兼容字段。验证码、会员开通、付款驳回与 SMTP 测试邮件已支持本地化。
- 用户语言偏好可持久化到 `users.locale`；登录和语言切换后同步，会员开通与付款驳回邮件按收件人语言发送。
- **Phase 7：Content i18n + AI Translation 🚧**。7·1A 已完成作品原文 locale、译文版本表和 content module；7·1B 已将 published 译文接入公开首页、作品列表与详情页，并在缺失译文时回落原文；7·2A/7·2B 已完成后台译文管理 API 与 en/ja 手动录入界面。
- 7·3A 已加入默认关闭的翻译 Integration、加密 provider 配置和 OpenAI-compatible adapter，但尚未提供生成入口，也不会调用外部服务。AI Translation 依赖内容多语言数据模型，只用于辅助生成译文草稿，**权限完全归创作者**：
  1. 系统不得默认替创作者开启 AI 翻译；
  2. 不得默认让访客消耗创作者的 AI 额度；
  3. AI 生成结果默认是草稿，未经创作者确认不得公开；
  4. 翻译语言、范围、服务与发布策略必须由创作者明确选择。
- 详见 [architecture/i18n-ai-translation.md](architecture/i18n-ai-translation.md)。

## 8. Deployment & Network Edge

- App 本身**不直接处理 TLS**，TLS 终止交给 Cloudflare / Caddy / Traefik / Nginx / CDN。✅（当前以 Cloudflare Tunnel 为主路径）
- 健康检查接口 `/api/health`（存活）、`/api/ready`（就绪）✅，为反向代理与负载均衡预留。
- 后期支持：公网 VPS 部署指南、自动 SSL（Caddy/Traefik 示例）、其他 CDN、真实客户端 IP 透传与记录、负载均衡与高可用。🚧
- 详见 [architecture/deployment-network-edge.md](architecture/deployment-network-edge.md)。

## 9. 安全需求

| 需求 | 状态 |
|---|---|
| 生产环境禁止默认 / 弱 `SESSION_SECRET`（启动失败） | ✅ |
| 邮箱验证码限流（邮箱每小时 5 次、60s 冷却、IP 每小时 20 次） | ✅ |
| Cloudflare Turnstile 保护验证码发送接口（可选开启） | ✅ |
| Turnstile Siteverify 调用前的 IP 限流 | ✅ |
| 配置加密根密钥自动生成并持久化（权限 600，不打印密钥） | ✅ |
| 验证码 HMAC 哈希存储、尝试次数限制 | ✅ |
| 下载全量鉴权 + 日志 | ✅ |
| 敏感配置加密存储（依赖配置中心） | 🚧 |
| 完整审计日志与导出 | 🚧 |
| 真实 IP 透传校验（仅信任已配置的代理层） | 🚧 |

## 10. 配置中心方向 🚧

- 目标：将运营类配置（SMTP、S3、Turnstile 等）逐步迁入数据库，由后台管理；敏感字段使用配置加密根密钥（AES）加密存储。
- 当前已完成的铺垫：根密钥生成 / 持久化 / 读取能力 ✅。
- 原则：环境变量始终保留为最高优先级覆盖手段；迁移过程不破坏现有 `.env` 部署方式。

## 11. 路线图（摘要）

Phase 0 MVP（已完成）→ Phase 1 安全基础 → Phase 2 配置中心 → Phase 3 部署与网络边缘 → Phase 4 Integration 架构 → Phase 5 Theme v1 → Phase 6 UI i18n v1（已完成）→ Phase 7 Content i18n + AI Translation → Phase 8 Plugin v0 → Phase 9 Hub 官方插件 → Phase 10 负载均衡与高可用。

完整内容见 [roadmap.md](roadmap.md)。

## 12. 验收标准

### Phase 0（已完成）✅

- Docker Compose 启动、数据库迁移、站点初始化、管理员登录、粉丝验证码登录、付款截图上传、后台审核、自动开通会员、会员内容权限下载、local 存储、local/S3 历史文件按记录驱动读取与删除。

### Phase 1（当前轮验收口径）

1. Turnstile 关闭时，邮箱验证码登录流程与之前完全一致。
2. Turnstile 开启且 token 缺失 → 400，不发送邮件。
3. Turnstile 开启且 token 无效 → 403，不发送邮件。
4. Turnstile 开启且 token 有效 → 正常发送邮件；现有限流逻辑保留。
5. 生产环境 `SESSION_SECRET` 为默认值 / 过短 / 为空时应用启动失败，开发环境不受影响。
6. Docker 首次启动自动生成 `/app/secrets/config-encryption-key`（600），重启后密钥不变。
7. `/api/health` 返回 200；`/api/ready` 数据库正常时 200、异常时 503，且不暴露任何 secret。
8. 文档区分已实现与计划中，不夸大。

### 后续 Phase

各 Phase 的验收标准在进入该阶段时于 roadmap 中细化。
