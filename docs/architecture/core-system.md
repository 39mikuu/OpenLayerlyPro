# Core 单站系统架构

> ✅ 已实现｜▶ v1.0 当前硬化｜🚧 后续计划

## 定位

Core 是 OpenLayerlyPro 的不可拆卸核心：即使所有可选 Integration 关闭，也能依靠本地存储、人工付款和内置主题完成「粉丝付费 → 审核/确认 → 开通会员 → 权限下载」主闭环。

## Core 的职责边界

Core 负责且仅 Core 负责：

| 职责 | 说明 | 状态 |
|---|---|---|
| 会员 | 等级、按笔时间窗、active/suspended/revoked 生命周期、按 user 串行授予 | ✅ |
| 内容 | 作品、定时发布、分类/标签、Markdown、内联媒体、public/login/member 权限、多语言版本 | ✅ |
| 文件 | 有界上传、权威 MIME、图片重编码/quarantine、local/S3、Range、引用与删除生命周期 | ✅ |
| 下载鉴权 | 所有非公开字节逐请求鉴权、日志与限流；公开 S3 只按真实公开授权签名 | ✅ |
| 付款与订阅 | 人工审核、Stripe 一次性/订阅、手动提醒、退款/拒付、provider inbox/dispatch/reconcile | ✅ |
| Session / Auth | 管理员会话、粉丝验证码、Turnstile、可信 IP、S4 rate-limit/fence | ✅ |
| 配置中心 | 加密 `app_settings` 与 SMTP/Turnstile/Storage/Upload/Stripe/Translation 管理 | ✅ |
| 审计与任务 | `audit_events` 因果链、`app_events`、durable task/outbox、lease/fencing/retry | ✅ |
| 全局安全响应头 | per-request nonce CSP、动态来源与 legacy footer 迁移 | ▶ #86 |
| 恢复一致性 | archive integrity、schema probe、任务中和、文件 backfill 与 DB↔存储收敛 | ▶ #87 |

不属于 Core 的：主题布局与视觉实现（Theme）、第三方扩展机制（Plugin）、跨站聚合发现（Hub）和多实例编排。Integration 是官方内置 adapter；其调用必须经过 Core 的事务、权限、审计和幂等边界。

## 代码结构（现状）

```txt
src/
├── app/                     # Next.js App Router：页面 + Route Handler
│   └── api/                 # auth/admin/payment/files/health/ready 等入口
├── components/              # admin 与交互组件
├── themes/                  # 内置主题；只消费 Core view-model
├── modules/
│   ├── auth/                # login code、admin login、session、rate-limit identity
│   ├── content/             # 发布、分页、翻译、Markdown/inline refs
│   ├── membership/          # 生命周期、grant 串行化、有效会员投影
│   ├── payment/             # 人工付款、Stripe、订阅、refund/dispute/reconcile
│   ├── file/                # 上传安全、backfill、引用与 cleanup
│   ├── storage/             # local / S3 adapter
│   ├── download/            # 授权、Range、日志与签名 URL
│   ├── mail/                # 模板、可靠投递与 delivery ledger
│   ├── tasks/               # durable queue、dispatcher、lease/fencing
│   ├── config/              # 加密配置组与最终配置解析
│   ├── integration/         # 官方 adapter 注册表、状态与连接测试
│   ├── i18n/                # zh/en/ja 字典与 locale
│   └── system/              # readiness、状态与事件
├── lib/                     # env、API/error、crypto、request-body、rate-limit、logger
└── db/                      # Drizzle schema、迁移、连接
```

## 关键约定

1. **Route Handler 不承载业务**：入口只做有界读取、认证/授权顺序、输入解析、调用 modules 和统一响应。
2. **统一错误模型**：业务错误使用稳定 `code` 与结构化 `params`；兼容 `error` 文案由统一响应层输出。
3. **请求体先有界再解析**：生产 Route Handler 禁止直接使用未封装的 `req.json()`、`req.text()` 或 `req.formData()`；CI 由 `check:request-bodies` 阻止回退。
4. **env 集中校验**：环境变量经 `src/lib/env.ts` 的 zod schema；生产运行时 fail-loud，`next build` 只跳过不必要的运行时依赖。
5. **配置契约单一来源**：消费者只调用 `src/modules/config/*`；不得在 UI、Integration 与业务模块各维护一份启用/来源判断。
6. **存储位置按文件记录**：历史文件按 `storageDriver` 与 bucket 读取；切换当前 driver 不迁移旧文件。
7. **事务外不做外部 I/O**：SMTP、Stripe/S3 网络调用不得占用数据库事务或 advisory lock；使用 claim/fence 分阶段提交。
8. **敏感信息不落日志/任务 JSON**：secret、token、验证码明文、raw email 与原始 provider 错误必须清洗或加密。
9. **单实例边界明确**：当前限流与 dispatcher 以单 app 实例为目标；多实例共享 limiter/调度属于 Phase 10。

## 登录安全与真实 IP

### 当前实现

- 默认至少 16 位 uppercase Crockford base32 登录码；数据库只存 keyed digest，不存可恢复明文。
- 同邮箱 active code 与 durable delivery task 使用并发安全 fence；新请求统一返回 accepted，不泄漏是否实际发信。
- 正确码先进入核心比较，wrong/expired 结果确认后才记 IP、email+IP 或 unresolved 错误预算。
- source-scoped pre-comparison hard budget 限制昂贵比较，但不能让第三方只凭受害者 email 锁死正确码。
- Turnstile、request-code、verify-code 和 admin-login 都使用可信 resolved identity 或各操作独立的 unresolved emergency bucket。
- 登录码任务在短事务内 claim/fence，SMTP 在事务与 advisory lock 之外执行；stale task 成功 no-op。

权威语义见 [../handoff/harden-s4-auth-rate-limiting.md](../handoff/harden-s4-auth-rate-limiting.md)。底层 limiter 仍是进程内实现；v1.0 不承诺多副本全局计数。

## 配置加密与配置中心

- 根密钥优先级：`CONFIG_ENCRYPTION_KEY` 环境变量 > `CONFIG_ENCRYPTION_KEY_FILE` 文件；Docker 首启可生成权限 600 的持久化文件。
- `app_settings` 以 AES-256-GCM 整组加密；密钥错误、密文损坏或认证失败均抛错，不返回伪默认值。
- SMTP、Turnstile、Storage、Upload 解析 DB ＞ env ＞ default；Stripe 与 Translation 使用后台加密配置并默认关闭。
- 管理 API 只返回掩码/是否已设置，不返回 secret。
- 配置加密根密钥与 `SESSION_SECRET` 用途不同，恢复时必须分别管理。

## 审计、任务与支付事件

- 业务状态变化与 `audit_events` 在同一事务提交，使用 `correlation_id` / `causation_id` 连接因果链。
- `tasks` 使用 dedupe key、lease、随机 `locked_by` token、续租与最终 fencing；外部 I/O 后只有当前 claim 可提交结果。
- Stripe webhook 验签后持久化 normalized provider event，再返回 2xx；dispatcher 负责业务处理，event-id 与 invoice-id 双层幂等。
- 终态 task 仍占用全局 dedupe key，因此恢复/重建流程必须显式 re-arm、upsert 或删除对应行，不能假设普通 enqueue 会覆盖。

## v1.0 剩余边界

- #86：HTML 文档全局安全头、per-request nonce CSP、Turnstile/S3/video/integration 精确来源和 legacy footer rollout。
- #87：archive v2/checksum、v1 schema probe、mandatory file-safety remediation、任务/支付事件中和、DB↔local/S3 收敛。
- #88：真实 Stripe、local/S3、升级/恢复、安全攻击回归与完整发布验收。
