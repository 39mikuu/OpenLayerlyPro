# v1.2 计划书：登录与会员权益完成度

> 状态：**规划中**。基线为 2026-07-17 发布的 `v1.1.0`（tag `3a80b34`）。
>
> 2026-07-17 确认的范围：
>
> - 粉丝登录依次实现邮件 Magic Link、Google OAuth 和 GitHub OAuth；管理员继续使用邮箱 + 密码，邮箱验证码保留。
> - Membership Bundle 只在 `membership_tiers` 上配置 Core 白名单权益，并按当前 tier 实时解析；不引入通用 `EntitlementGrant`。
> - G3 legacy compatibility removal 不进入 v1.2，另行安排在不早于 2026-10-14 的版本（当前预期 v1.3）。
> - G2 `monthlyCharLimit` 保持“仅记录，不限制”，不在 v1.2 增加本地强制预算。

## 1. 版本主题与背景

v1.2 聚焦粉丝登录和会员权益配置，同时处理两项低风险工程债：

1. 增加 Magic Link 和 OAuth，保留现有管理员认证边界及邮箱验证码入口。
2. 在现有 tier 模型内增加白名单权益，不新建并行授权系统。
3. 处理 G5、G7；dispatcher 查询优化保持 v1.1.0 现有回归，不扩展 worker 执行模型。

## 2. 产品优先级与实施顺序

工作包编号表示**产品优先级**：WP1 → WP2 → WP3 → WP4。WP1/WP2 属 Core Auth，WP3 属 Membership Core，WP4 属债务包。

实施顺序与工作包编号一致，并按 §4 的里程碑串行合并。

## 3. 范围：四个工作包

### WP1 邮件 Magic Link 登录

- **用户故事**：粉丝输入邮箱后可通过邮件中的登录链接进入自己的会员账户，不必复制验证码；验证码登录仍作为 fallback。
- **范围内**
  - 粉丝/会员 Magic Link request、邮件投递、确认与 session 创建；管理员入口不使用 Magic Link。
  - 一次性 token 只以 hash 形式存储；原始 token 只出现在发送给用户的链接中，不进入日志、任务详情、后台响应或 audit payload。
  - 短有效期、单次使用、重放保护、redirect allowlist 与登录后安全跳转。
  - 携带 token 的确认页、确认 API 与错误响应必须设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex`；参照 `src/app/api/notifications/unsubscribe/[token]/route.ts` 的 token response header precedent。
  - 邮件客户端 prefetch 防误登录：GET 链接只展示确认页或等价非消费状态，必须由用户显式确认后才消费 token。
  - tokenless result redirect：确认完成后跳转到不含 token 且 query 已剥离的结果 URL，并从地址栏移除原始 token。
  - request 响应必须抵抗账号枚举：存在/不存在邮箱统一返回 accepted，不暴露用户是否存在、是否已 opt-in 或是否发送成功。
  - token key/hash 管理明确化：token hash at rest、单次使用 CAS 消费、key id 记录与 keyring/rotation 流程，沿用 WP2 通知退订的 `getNotificationUnsubscribeKeys()` / `NOTIFICATION_UNSUBSCRIBE_*` current+previous key precedent。
  - 复用现有 SMTP、Turnstile、S4 限流、session、durable task/outbox、i18n 邮件与 audit 基座。
- **范围外**：管理员 Magic Link、passwordless 管理后台、WebAuthn/passkeys、第三方 Auth provider。
- **实现要点**
  - request 阶段沿用邮箱规范化和 source-scoped 限流；不可用 SMTP 必须进入可观测 defer/dead/retry，而不是假成功。
  - token 消费必须以条件更新 / compare-and-swap 原子化，只允许 `hash + keyId + 未消费 + 未过期` 的第一笔事务创建 session，防止并发双击、重复点击或预取造成多 session。
  - redirect 只允许站内相对路径或显式 allowlist；拒绝外部 open redirect。
  - audit 记录 request、send、consume、replay/expired/rejected 等安全事件，但只保留安全摘要。
- **验收**
  - [ ] token hash 存储、短有效期、单次使用、重放保护和并发消费使用真实 PostgreSQL 测试覆盖。
  - [ ] 邮件客户端 prefetch 不会完成登录；用户显式确认后才创建 session。
  - [ ] token-bearing 响应具备 `no-store` / `no-referrer` / `noindex`；确认后地址栏和结果跳转不再携带 token 或原 query。
  - [ ] request 接口对存在/不存在邮箱返回统一 accepted，发送与观测路径不泄露账号枚举信号。
  - [ ] Magic Link keyring 支持 current+previous 验证、rotation、key id 记录和旧 key 退役；实现与通知退订 keyring precedent 保持一致。
  - [ ] redirect allowlist、Turnstile、限流和邮箱验证码 fallback 均有回归覆盖。
  - [ ] 真实 SMTP 完成 Magic Link 邮件发送、点击、过期、重放和安全日志验收。
  - [ ] zh/en/ja 登录页、邮件、错误文案和后台观测文案同步。

### WP2 Google / GitHub OAuth

- **用户故事**：粉丝可使用 Google 或 GitHub 登录会员账户；已有邮箱账户可在 verified email 匹配时自动绑定。
- **范围内**
  - Google OAuth 与 GitHub OAuth 粉丝/会员登录；管理员登录继续邮箱 + 密码。
  - OAuth client id/secret、callback URL 与启用状态通过既有加密配置存储管理；secret 加密持久化，不返回前端、不进日志。
  - Google/GitHub provider 状态进入后台 Integration status registry，使用与 Umami 同等的 3-state 语义（未配置 / 已配置未启用 / 已启用，附 source/error 摘要）。
  - 新增 dedicated identity table，唯一约束 `(provider, provider_account_id)`；provider identity 是绑定主键，不以邮箱作为唯一身份源。
  - 绑定优先级固定：provider identity 命中优先，其次才允许 verified-email 自动绑定；发生 identity/user/email 冲突时 fail closed 并返回明确错误，禁止 silent rebind。
  - fail-closed 默认：Google `email_verified=false` 拒绝；GitHub 无 verified email 或无法确认 verified email 时拒绝。
  - 保留邮箱验证码 fallback；provider outage、配置错误或 OAuth 回调失败不得影响邮箱验证码登录，Magic Link 也不被 OAuth 取代。
- **范围外**：管理员 OAuth、组织/team 授权、账号合并 UI、OAuth provider marketplace、OIDC 泛化框架。
- **实现要点**
  - OAuth 必须使用 PKCE S256 + state；server-side verifier 持久化必须有 TTL、single-use 消费和回调后清理，防 CSRF、重放与 session fixation；错误回调不得泄露 provider raw error 或 token。
  - callback redirect 只允许站内相对路径或显式 allowlist，拒绝 open redirect。
  - GitHub 需使用可验证邮箱来源；不能因 public profile 缺邮箱而创建未绑定身份。
  - OAuth identity 与 user 绑定写入必须幂等，并能处理重复 callback、并发 callback 和 provider id 重放。
  - Integration 状态读取必须复用 config 模块，不复制 secret 完整性判断。
- **验收**
  - [ ] Google 与 GitHub live round-trip 证据收集完成，覆盖新 member 创建、verified email 绑定既有账户、取消授权和错误回调。
  - [ ] 已存在 provider identity 返回 changed verified email 时，identity precedence 胜出，不发生 email-based rebind，并有真实 PostgreSQL 或集成测试覆盖。
  - [ ] GitHub 无 verified email / Google 未验证 email 均 fail closed，并有测试覆盖。
  - [ ] OAuth PKCE S256、state verifier server-side persistence、TTL、single-use、callback 幂等、重复 callback、redirect allowlist 与错误脱敏有单元或真实 PostgreSQL 覆盖。
  - [ ] provider outage / 5xx / timeout 不影响邮箱验证码 fallback，可观测错误不泄露 raw provider payload。
  - [ ] 后台配置与 Integration status registry 不返回 secret；配置删除可安全停用 provider，3-state 行为与 Umami parity 通过。
  - [ ] zh/en/ja 登录按钮、错误文案、后台配置和部署说明同步。

### WP3 Membership Bundle

- **用户故事**：创作者可在会员等级上配置一组清晰的权益标签，让粉丝知道每个 tier 包含什么，并为后续精细授权留下 Core 入口。
- **范围内**
  - `membership_tiers` 增加白名单 entitlements 配置；第一版只允许 Core 定义的稳定 key，不接受任意字符串授权。
  - 后台 tier 编辑 UI 展示、编辑和审计 entitlements；公开 tier 卡片和会员页可展示权益说明。现有 tier routes 目前不写 audit，v1.2 必须把 entitlement 写入纳入 ADR-0002 审计边界。
  - Core 授权 helper 可读取 entitlements，但保留现有 tier level / `requiredTierId` 兼容逻辑。
  - 访问与下载相关路径使用真实 PostgreSQL 测试覆盖，证明现有 `canAccessPost()` / `canAccessFile()` 行为不被绕过。
- **范围外**：通用 `EntitlementGrant`、用户级临时授权、PPV/Tips 绑定、按文件独立 entitlement 要求、视频 cover/thumbnail/duration metadata。
- **实现要点**
  - entitlements 是 tier 配置，不是独立授权事实源；付款、订阅、反转、suspend/revoke 仍以 membership 生命周期为准。
  - live-tier semantics：授权读取访问时的当前 tier row，与现有 level / `requiredTierId` 行为一致；编辑 entitlements 会立即影响既有 active membership，不创建 membership-time snapshot。
  - entitlement 编辑必须在业务事务内写入 ADR-0002-compliant audit；before/after payload 只允许白名单 entitlement key、启用状态和展示摘要，不记录任意原始请求体。
  - 白名单 key 需有稳定含义、三语展示文案和迁移默认值；未知 key fail closed。
  - 如新增授权 helper，必须成为内容和下载路径的共同入口，不得让 Theme 或 UI 自行判断权限。
  - tier 删除、停售、历史 membership 与 subscription snapshot 语义不得被 entitlements 迁移破坏。
- **验收**
  - [ ] `membership_tiers` entitlements migration、默认值、未知 key 校验和后台保存使用真实 PostgreSQL 测试覆盖。
  - [ ] 公开 tier 展示、会员页展示、后台编辑与 audit 记录完成 zh/en/ja 覆盖；entitlement 编辑与 ADR-0002 audit 在同一事务提交/回滚。
  - [ ] whitelisted before/after audit snapshots 不包含 raw request body、secret 或未授权字段。
  - [ ] live-tier semantics 有测试覆盖：编辑当前 tier entitlements 后，既有 active membership 的访问结果立即按新权益解析。
  - [ ] `canAccessPost()` / `canAccessFile()` 现有 tier level 行为回归通过；新增 helper 不绕过文件引用完整性和下载鉴权。
  - [ ] suspend/revoke/expired membership 不因 entitlements 误授予访问。
  - [ ] 不引入 `EntitlementGrant`、PPV/Tips coupling 或视频 metadata schema。

### WP4 债务包：G5 / G7

- **用户故事**：维护者在不扩大产品面的前提下清理 v1.1 后剩余的低风险工程债，降低 CI 与公开统计边界风险。
- **范围内**
  - G5：处理 CI actions Node 20 deprecation 警告，升级相关 GitHub Actions 到当前主版本，并保持第三方 action 使用不可变 commit SHA；`pages.yml` 也应停止使用浮动 tag。
  - G7：补齐 Plausible 与 Umami 的 SPA tracking parity，复用共享公开页路径谓词，关闭默认自动 pageview 并改为 nonce inline 手动追踪；后台 Integration status registry 补齐 Plausible 同等状态语义。
- **baseline 说明**：dispatcher low-risk query optimization 已在 v1.1.0 baseline 完成（migration 0021 `tasks_claimable_idx` / `tasks_stale_lease_idx`、`src/modules/tasks/dispatcher.ts` once-per-tick sweep、真实 PostgreSQL split-claim 回归测试）；v1.2 只保持这些回归为绿，不再把 query optimization 列入新 scope。
- **范围外**：batch-claim worker model、bounded parallel execution、dequeue-time lease renewal、多实例 worker 池、任务执行模型重构。
- **实现要点**
  - G5 的 action 升级不得放弃 SHA pin；版本注释可更新，但实际 `uses` 必须指向不可变 commit。
  - G7 需保持 public integrations 的 CSP/revision 安全模型；非公开路径（`/me`、`/checkout/*`、`/admin` 等）不得继续上报 Plausible pageview。
  - dispatcher baseline 回归只验证既有 claim-one / execute-one lease timing、`FOR UPDATE SKIP LOCKED`、attempt guard、fencing 和外部 I/O 不在事务内的边界仍未退化。
- **验收**
  - [ ] CI workflows 中相关 third-party actions 均 pin 到 commit SHA，且升级后 CI 绿。
  - [ ] Plausible SPA 导航只在公开页边界内上报；非公开路径无 pageview；CSP/revision 与 Umami parity 通过浏览器或 e2e 验证。
  - [ ] dispatcher v1.1.0 baseline 回归保持绿；不新增 migration、query path 或 worker execution model scope。
  - [ ] batch-claim / bounded worker pool 没有随本包落地；如另需推进，必须重新设计并单独验收 lease-before-start 风险。

## 4. 实施里程碑

```text
M0  v1.1.0 发布完成（2026-07-17，tag 3a80b34）
M1  WP1 邮件 Magic Link
M2  WP2 Google / GitHub OAuth（以 M1 为前置）
M3  WP3 Membership Bundle
M4  WP4 债务包：G5 CI actions、G7 Plausible parity；dispatcher baseline 回归保持绿
M5  v1.2 验收与发布（明确不包含 G3 legacy removal）
```

M1-M4 必须串行合并；每个里程碑合并后由创作者实例 dogfood。发现 Auth、会员授权、通知、统计或 task regression 时，在下一个里程碑前优先修复。

M5 只验收本计划纳入的 WP。G3 legacy compatibility removal 不进入 v1.2，无论 v1.2 的发布日期为何，都保留 v1 archive restore、legacy footer migration 和 pre-v1.0 file backfill compatibility paths。

## 5. v1.2 范围外与后续候选

| 项 | 状态 | 理由 / 触发条件 |
|---|---|---|
| G3 legacy compatibility removal | 顺延，当前预期 v1.3 | v1.2 明确保留三条兼容路径；移除需另行立项，且不得早于 2026-10-14 |
| 通用 `EntitlementGrant` | 不做 | v1.2 Membership Bundle 只在 `membership_tiers` 配置 Core 白名单 entitlements，避免引入并行授权事实源 |
| PPV / Tips coupling | 不做 | 支付型新商业能力需要单独产品定义、退款/撤销语义和文件鉴权设计 |
| 视频封面/缩略图/时长 metadata | 未来候选 | 与 Auth/Membership 主线不同，不纳入 v1.2 |
| batch-claim worker model | 条件触发 | `issue-101` §4.1 指出 lease-before-start 风险；需独立设计 bounded parallelism 与 lease protection 后再推进 |
| 管理员 OAuth / passkeys | 后续候选 | v1.2 Auth 仅粉丝/会员登录；管理员继续邮箱 + 密码 |
| 评论系统 | 不做 | 反垃圾、审核、法务和对话状态不进入 Core |
| 主题包上传 / 主题市场 | 维持 ⏸ | 不规划第三方主题生命周期；官方内置主题能力单独评估 |
| Plugin runtime / Hub / HA | Plugin/Hub 暂不规划；HA 维持 roadmap 触发条件 | 不进入 v1.2 Core；Hub 未来只有在真实运营证明需要跨站发现时再作为独立产品方向重新评估 |

## 6. 发布门槛

- [ ] 全部纳入范围的 WP 验收通过；发布证据必须绑定 exact release HEAD，不能引用旧 SHA、摘要或非目标分支 run。
- [ ] `.github/workflows/ci.yml` 在 exact release HEAD 通过；同时保留本地/CI 静态门证据：`pnpm check:request-bodies` 与 `pnpm check:auth-before-body` 均绿。
- [ ] exact release HEAD 手动 dispatch `.github/workflows/restore-drills.yml` 通过；从 `v1.1.0` 原地升级演练通过，且 restore drills 仍覆盖 legacy v1 restore compatibility（本版不移除）。
- [ ] `pnpm build` 与浏览器/e2e 验证通过；若网站 `website/` 或 Pages 配置发生变化，必须附 exact-head Pages workflow 证据。
- [ ] Magic Link 完成真实 SMTP 证据：邮件可达、确认登录成功、过期失败、重放失败、prefetch 不消费、redirect allowlist、Turnstile/限流复用、audit 安全摘要和无 token 泄露。
- [ ] OAuth 完成 Google 与 GitHub live round-trip 证据：verified email 绑定既有账户、创建新 member、取消授权、错误回调、GitHub 无 verified email fail closed、secret 不泄露。
- [ ] Membership Bundle 的 schema、后台 UI、Core helper、内容访问与下载鉴权完成真实 PostgreSQL 测试；现有 tier level / `requiredTierId` 行为保持兼容。
- [ ] G5/G7 债务包通过对应回归：Actions SHA pin、Plausible SPA 公开页边界、Integration status parity；dispatcher baseline claim invariants 保持绿。
- [ ] G4 i18n key 完整性和 G6 已落地主题视觉回归持续为绿；新增 Auth/Membership/Integration 文案必须同步 zh/en/ja。
- [ ] 每个里程碑完成创作者实例 dogfood；M5 汇总真实 SMTP、OAuth live、entitlement real-PG、upgrade、restore、e2e/build、docs/三语 sync 证据。
- [ ] CHANGELOG、PRD、roadmap、admin/deployment/architecture 文档和三语官网同步。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Magic Link 被邮件客户端预取误消费 | GET 不创建 session，只展示确认页或等价非消费状态；显式确认才原子消费 token |
| Magic Link token 泄露或重放 | 只存 hash、短有效期、单次使用、并发消费测试、日志/audit/admin 响应脱敏 |
| OAuth email 绑定错误 | provider identity 优先；verified email 仅作自动绑定候选；冲突 fail closed，changed verified email 不触发 silent rebind |
| OAuth secret 暴露 | 复用 `app_settings` 加密配置；Integration status 只返回结构化状态，不返回 secret 或 raw provider error |
| Membership Bundle 变成并行授权系统 | 只允许 `membership_tiers` 白名单 entitlements；保留 membership 生命周期和 tier level 兼容逻辑 |
| 下载鉴权被 UI entitlement 绕过 | Core helper 统一授权；真实 PostgreSQL 覆盖 `canAccessPost()` / `canAccessFile()` 与 suspend/revoke/expired 路径 |
| 债务包扩大成 worker 重构 | dispatcher query optimization 已属 v1.1.0 baseline；M4 不新增 task query/worker scope，batch claim 与 bounded parallelism 明确范围外 |
| G3 removal 扩大 v1.2 范围 | v1.2 明确保留三条兼容路径；移除另行立项 |

## 8. 成功信号

- 粉丝可通过 Magic Link、Google OAuth 或 GitHub OAuth 完成登录，验证码 fallback 仍可用。
- 创作者实例 dogfood 后，登录失败率、重复登录邮件和 OAuth 支持请求没有异常。
- 会员 tier 页面能清楚表达权益，且没有引入绕过现有内容/文件鉴权的路径。
- CI 与 Plausible tracking 的 v1.1 后债务关闭；dispatcher v1.1 baseline 回归保持绿，未扩大到高风险执行模型重构。

发布后 4 周复盘，并据真实使用确定 v1.3 主题。G3 legacy removal 的最早实施日期为 2026-10-14。
