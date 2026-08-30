# Core 单站系统架构

> ✅ 已实现｜▶ 当前发布准备｜🚧 后续计划

## 定位

Core 是 OpenLayerlyPro 的不可拆卸核心：即使所有可选 Integration 关闭，也能依靠本地存储、人工付款和内置主题完成「粉丝付费 → 审核/确认 → 开通会员 → 权限下载」主闭环。

## Core 的职责边界

Core 负责且仅 Core 负责：

| 职责 | 说明 | 状态 |
|---|---|---|
| 会员 | 等级、按笔时间窗、active/suspended/revoked 生命周期、按 user 串行授予、当前 tier 白名单权益 | ✅ |
| 内容 | 作品、定时发布、分类/标签、Markdown、内联媒体、public/login/member 权限、多语言版本 | ✅ |
| 文件 | 有界上传、权威 MIME、图片重编码/quarantine、local/S3、Range、引用与删除生命周期、上传 orphan journal | ✅ |
| 下载鉴权 | 所有非公开字节逐请求鉴权、日志与限流；公开 S3 只按真实公开授权签名 | ✅ |
| 付款与订阅 | 人工审核、Stripe 一次性/订阅、手动提醒、退款/拒付、provider inbox/dispatch/reconcile | ✅ |
| Session / Auth | 管理员邮箱密码与会话、粉丝验证码/Magic Link、公共 Google/GitHub OAuth（可按 [ADR-0012](../adr/0012-oauth-fan-login.md) 绑定已有管理员）、Turnstile、可信 IP、S4 rate-limit/fence | ✅ |
| 配置中心 | 加密 `app_settings`、revision/CAS 与 SMTP/Turnstile/Storage/Upload/Stripe/OAuth/Translation 管理 | ✅ |
| 审计与任务 | `audit_events` 因果链、`app_events`、durable task/outbox、lease/fencing/retry | ✅ |
| 全局安全响应头 | per-request nonce CSP、动态来源与 legacy footer 迁移 | ✅ #86 |
| 恢复一致性 | archive integrity、schema probe、任务中和、文件 backfill 与 DB↔存储收敛 | ✅ #87 |

不属于 Core 的：主题布局与视觉实现（Theme）、聚合发现（Hub，暂不规划）和多实例编排。项目不再规划通用第三方 Plugin runtime。Integration 是官方内置 adapter；其调用必须经过 Core 的事务、权限、审计和幂等边界。

## 代码结构（现状）

```txt
src/
├── app/                     # Next.js App Router：页面 + Route Handler
│   └── api/                 # auth/admin/payment/files/health/ready 等入口
├── components/              # admin 与交互组件
├── themes/                  # 内置主题；只消费 Core view-model
├── modules/
│   ├── auth/                # login code、Magic Link、OAuth、admin login、session、rate-limit identity
│   ├── content/             # 发布、分页、翻译、Markdown/inline refs
│   ├── membership/          # 生命周期、grant 串行化、有效会员投影
│   ├── payment/             # 人工付款、Stripe、订阅、refund/dispute/reconcile
│   ├── file/                # 上传安全、backfill、引用与 cleanup
│   ├── storage/             # local / S3 adapter
│   ├── download/            # 授权、Range、日志与签名 URL
│   ├── mail/                # 模板、可靠投递与 delivery ledger
│   ├── tasks/               # durable queue；enqueue/runtime/admin/ops 显式入口
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
   文件上传在对象写入前原子创建 `storage_upload_journal` 与 cleanup task；成功时 `files` 行与 journal 消费同事务提交。cleanup 删除无精确引用的对象后仍保留 tombstone 并低频重复幂等删除，因为 S3-compatible provider 没有统一可证明的最晚提交上界；只有正常上传事务消费 journal 或发现精确 `files` 引用时才移除。删除失败耗尽单轮重试的 task 会在冷却后自动重新武装。失败上传会因此永久占用一行 journal/task 并周期性调用 provider DELETE，运维需监控 maintenance backlog 与存储 API 配额。
8. **敏感信息边界明确**：secret、token、验证码明文和原始 provider 错误不得进入日志、非授权管理响应或可公开输出。`kind='email'` 的业务事务邮件任务只保存业务引用，不保存 `to` 收件人地址，worker 在发送时解析最新邮箱与 locale。`auth.login_code_email` / `auth.magic_link_email` 保存认证记录 ID、加密的 code/token 和可选请求 locale，不保存明文收件人、code 或 token；handler 在发送前从认证记录解析当前邮箱并解密一次性 secret。任务表及其业务引用仍须按敏感用户数据保护数据库访问、备份与留存。
9. **单实例边界明确**：当前限流与 dispatcher 以单 app 实例为目标；多实例共享 limiter/调度属于 Phase 10。
10. **任务模块入口明确**：业务事务只从 `tasks/enqueue` 入队；dispatcher 只从 `tasks/runtime` 领取、续租和终结；管理重试与运维聚合分别使用 `tasks/admin`、`tasks/operational-snapshot`。禁止通过 `tasks/index` 桶入口跨越这些边界，CI 由 `check:task-boundaries` 阻止回退。

## 登录安全与真实 IP

### 当前实现

- 默认至少 16 位 uppercase Crockford base32 登录码；数据库只存 keyed digest，不存可恢复明文。
- 同邮箱 active code 与 durable delivery task 使用并发安全 fence；新请求统一返回 accepted，不泄漏是否实际发信。
- 正确码先进入核心比较，wrong/expired 结果确认后才记 IP、email+IP 或 unresolved 错误预算。
- source-scoped pre-comparison hard budget 限制昂贵比较，但不能让第三方只凭受害者 email 锁死正确码。
- Turnstile、request-code、verify-code、Magic Link、OAuth 和 admin-login 在公网生产入口必须获得可信 resolved identity，否则失败关闭；只有受信任局域网/防火墙后的基础 Compose 直连可显式启用各操作独立的 unresolved emergency bucket，开发/测试也保留该诊断路径。
- 登录码任务在短事务内 claim/fence，SMTP 在事务与 advisory lock 之外执行；stale task 成功 no-op。
- Magic Link 只存 keyed hash；GET 仅展示不消费，显式确认才在同一事务内原子消费 token、创建/更新用户并插入 session。protocol-v2 rollout 通过独立 intake/delivery ledger、lease 与角色边界 fence 控制。
- Google/GitHub OAuth 使用 PKCE S256、单次 state、浏览器绑定与站内 redirect allowlist；provider identity 优先，只有 verified email 可自动绑定。provider 故障不影响验证码和 Magic Link fallback。

权威语义见 [../handoff/harden-s4-auth-rate-limiting.md](../handoff/harden-s4-auth-rate-limiting.md)。底层 limiter 仍是进程内实现；v1.0 不承诺多副本全局计数。

## 配置加密与配置中心

- 根密钥优先级：`CONFIG_ENCRYPTION_KEY` 环境变量 > `CONFIG_ENCRYPTION_KEY_FILE` 文件；Docker 首启可生成权限 600 的持久化文件。
- `app_settings` 以 AES-256-GCM 整组加密；密钥错误、密文损坏或认证失败均抛错，不返回伪默认值。
- SMTP、Turnstile、Storage、Upload 解析 DB ＞ env ＞ default；Stripe、Google/GitHub OAuth 与 Translation 使用后台加密配置并默认关闭。
- 管理 API 只返回掩码/是否已设置，不返回 secret。
- 配置加密根密钥与 `SESSION_SECRET` 用途不同，恢复时必须分别管理。

## 审计、任务与支付事件

- 业务状态变化与 `audit_events` 在同一事务提交，使用 `correlation_id` / `causation_id` 连接因果链。
- `tasks` 使用 dedupe key、lease、随机 `locked_by` token、续租与最终 fencing；外部 I/O 后只有当前 claim 可提交结果。
- `/admin/system` 与管理员系统状态 API 按需提供 queue class 聚合的运维快照；管理员首页不执行这项随任务历史增长的聚合。快照包含可领取到期、等待计划时间、活动租约、按真实 reclaim 条件计算的过期租约、最终租约过期待 sweep、已耗尽但不会被 claim/sweep 的 pending/failed、dead 与 fence 元数据异常计数，以及最早到期时间。各诊断维度可重叠（例如 fence 缺失但 lease 已过期的 processing 行同时计入过期租约和 fence 异常）。快照使用同一数据库时钟，且不返回任务 ID、kind、payload、错误或 lock token。
- Stripe webhook 验签后持久化 normalized provider event，再返回 2xx；dispatcher 负责业务处理，event-id 与 invoice-id 双层幂等。
- 终态 task 仍占用全局 dedupe key，因此恢复/重建流程必须显式 re-arm、upsert 或删除对应行，不能假设普通 enqueue 会覆盖。

## v1.0 收尾状态

- #87（已实现）：archive v3/checksum、v1 schema probe、mandatory file-safety remediation、任务/支付事件中和、DB↔local/S3 收敛。
- #88（真实环境验收，已完成于 v1.0.0）：真实 Stripe、local/S3、升级/恢复、安全攻击回归与完整发布验收——验证的是已实现的 #87 流程。
