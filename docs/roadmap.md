# 路线图（Roadmap）

> ✅ 已完成｜▶ 当前主线｜🚧 计划中｜⏸ 推迟。只有一个阶段可以标记为当前主线。

## 当前主线：v1.0 最终记录与发布 ▶

固定顺序：

```text
S6 #86 全局安全响应头 ✅
→ S7 #87 备份与恢复一致性 ✅
→ #88 v1.0 最终验收矩阵基线 ✅ 已关闭
→ 审计修复 #98–#103 / #112、#58 与 #119 ✅
→ #104 已完成外部真实环境验收的证据归档、最终候选冻结与发布
```

Phase 4 Integration 与 Phase 5 Theme 的 v1 基座已经完成。#64 已作为 v1.0 安全硬化实现 epic 关闭；这不等于 `v1.0.0` 已发布。当前唯一 open release gate 是 #104。操作者已完成真实 Stripe、SMTP、S3/R2、Turnstile/CSP、密钥托管与恢复验收；剩余工作是把证据、日期、环境和测试 SHA 规范写回发布报告，决定未决 Draft PR 的版本归属，冻结最终 `main`，完成 exact-final-SHA CI/受影响范围复验并由维护者授权发布。

## Phase 0：MVP 主链路 ✅

- Docker Compose、数据库迁移与站点初始化。
- 管理员登录、粉丝邮箱验证码登录。
- 人工付款审核、会员开通、内容权限与文件下载。
- local 存储及 local/S3 历史文件兼容。

## Phase 1：安全与工程基线 ✅

- Turnstile、生产 secret 校验、配置加密根密钥。
- `/api/health`、`/api/ready`。
- 格式、lint、类型、测试和 CI 基线。

## Phase 2：配置中心 ✅

- SMTP、Turnstile、Storage、Upload、Stripe、Translation 后台配置。
- 加密配置采用 DB override 与 env fallback 的统一读取入口。
- 内容附件上限直接 DB > env；付款凭证/二维码上限不能高于 env ceiling。

详见 [配置中心](./architecture/config-center.md)。

## Phase 3：部署与网络边缘 ✅

- 可信客户端 IP 与代理 hop 配置。
- VPS、CDN、Cloudflare Tunnel 部署路径。
- Range、private cache 与源站端口隔离边界。
- Caddy/Tunnel overlay 移除 app 的 host 3000 端口。

## Phase 4：Integration v1 基座 ✅

- 第一方 Integration 注册表、状态页与统一测试契约。
- SMTP、Storage、Stripe、Turnstile、Tunnel、Translation 状态收口。
- Stripe payment adapter 与 Translation provider 已存在，但它们是应用内第一方能力，不是通用 Plugin runtime。

**⏸ 后续：** 通用启停开关和第三方集成生命周期。

## Phase 5：Theme v1 基座 ✅

- 主题数据契约、内置主题与全部公开页面契约化。
- 明暗模式、字体、颜色预设与受约束自由取色。
- Theme 不负责权限、数据库访问或服务端 secret。

**🚧 v1.1 候选：** 第二主题、主题选择器、主题切换 audit 与双主题视觉回归门禁；Draft PR #123 尚未满足合并要求，也不属于已完成的 v1.0 基座。

详见 [Theme 架构](./architecture/theme-system.md)。

## Phase 6：UI i18n v1 ✅

- zh/en/ja 语言协商与用户偏好。
- 公开站点、后台、API 错误与系统邮件本地化。

## Phase 7：Content i18n + AI Translation ✅

- 版本化译文、前台回退、后台审核与发布。
- 管理员显式触发机器草稿，访客不能触发 provider 调用。
- `monthlyCharLimit` 当前仅保存和展示，不是本地强制预算。

## v1 Core hardening ✅

- 会员生命周期、付款审计与反转。
- durable task、租约、fencing 与重试。
- 管理员账号恢复、定时发布、标签分类。
- baseline 备份恢复与跨切面回归测试。

ADR 与 handoff 是设计和实施时点记录；当前行为以代码、architecture、admin/deployment 文档和 release checklist 为准。

## 自动变现与媒体能力 ✅（代码完成）

- Stripe 一次性付款、退款/拒付与 reconciliation。
- Stripe 自动订阅与手动续费提醒。
- keyset 分页、流式上传、S3 multipart。
- 视频附件、local/S3 单段 Range 与权限代理。

真实 Stripe、SMTP、S3/R2、Turnstile/CSP、密钥托管和恢复验收已由操作者完成；#104 当前负责证据同步、最终候选 SHA 绑定、必要的窄范围复验和发布授权。

## v1.0 安全硬化 ✅（实现完成）

已完成：S2、S3、订阅、S1a、S1b、S4、S5、S6、S7，以及审计确认的发布前修复。

- **S6 ✅**：#86；nonce CSP、动态来源、legacy footer 迁移和浏览器验证。
- **S7 ✅**：#87；archive v2、旧 archive 探测、文件安全修复、任务/支付事件中和和 DB↔存储收敛。
- **实现 epic ✅**：#64 已关闭。
- **发布记录与授权 ▶**：#104；归档已完成的真实环境证据，冻结 exact-final-main 候选，完成受影响范围复验、tag 与 GitHub Release。

## v1.1：不只画师 🚧

`v1.0.0` 发布并完成 4–6 周稳定窗口后启动。范围、产品优先级、实施顺序与发布门槛见 [release-v1.1-plan.md](./release-v1.1-plan.md)（提案）。Draft PR #123 不得通过提前合并绕过该前置条件；若维护者决定改变版本归属，必须先修改计划并把其纳入 #104 最终候选验收。

## Phase 8：Plugin v0 🚧

- 能力模型、隔离、生命周期与审计。

## Phase 9：Hub official plugin 🚧

- 聚合发现平台以官方插件形式提供。

## Phase 10：负载均衡与高可用 🚧

- 多实例共享限流、任务协调与配置失效机制。
- 负载均衡探活、滚动发布与故障演练。