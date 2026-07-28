# Issue #184：跨请求 Magic Link 角色不可区分性规格

- **状态**：Proposed（v8，按三轮独立复核 F1–F12、F184-01–F184-15、F-A–F-R 及 Codex delivery-aware / finalization / 晋升围栏复核修订）
- **Issue**：[#184](https://github.com/39mikuu/OpenLayerlyPro/issues/184)
- **设计基线**：`origin/main` `af24c6fd8fae8a07750f1ac648cdbae46f0e4c85`
- **变更类型**：Auth / anti-enumeration security fix（**含 schema 变更与 migration**）
- **前置**：[#175](./issue-175-magic-link-session-atomicity.md)、[#176](./issue-176-admin-magic-link-boundary.md)、[S4 认证限流硬化](./harden-s4-auth-rate-limiting.md)、[ADR 0003](../adr/0003-durable-task-and-outbox-boundary.md)

本文件是 Issue #184 的自包含权威规格。**v1 设计（三层内存预算）已被完全废弃**：独立复核 F1 指出它在「admin = 只读事务 / member = 写事务」上无法满足 Issue #184 不变量 1 的 latency-class 要求，而该不变量**不接受削弱、重新解释、豁免或修订**。v2 改为「角色无关的持久 intake + 通用处理任务」；v3–v5 修复重试时限、滚动发布安全、告警缺口、清理事务位置与队列吞吐等发现；v6 修复「mint 即作废已投递链接、但 SMTP 尚未成功」的可用性缺陷：替代 token 先以 pending/inactive 状态持久化，SMTP 成功后才在围栏事务中激活，并同时 supersede 旧的已投递 token；v7 固定跨 pending/active 的单调激活围栏、管理员角色判定的权威时点，以及 task 终态提交后的 pending-candidate 可重试清理；v8 补齐三处只靠事后检查而缺少串行化的边界——用可线性化的投递预留把管理员晋升与在途 SMTP 互斥（§5.3b）、让激活事务持 task 行锁并锁定该邮箱全部 token 行（消除租约抢占与「消费后仍激活」造成的第二个 session）、以及为 intake 行与 intake 门/cap 组合补上行锁与 fail-closed 校验。

---

## 1. 问题陈述

### 1.1 #176 留下的跨请求区分器

基线 `af24c6f` 的 `requestMagicLink()`（`src/modules/auth/magic-link.ts:139-294`，其事务回调为 `:163-284`）在**公开请求事务内**依次执行：

1. `pg_advisory_xact_lock(hashtext(normalizedEmail))`；
2. `magic_link_tokens` 活跃行 `SELECT ... FOR UPDATE`；
3. `users` 行 `SELECT role ... FOR UPDATE`；
4. `role === "admin"` → 记 `logger.info` 并 `return { suppressed: true }`；
5. 否则读 `tasks` 做 delivery fence、按 dedupe 窗口判断；
6. 消费共享 `request-code-email-ip:<digest>:<ip>`，耗尽则 `throw new ApiError(429, "requestRateLimited")`；
7. 作废旧 token、`INSERT magic_link_tokens`、`enqueueTask("auth.magic_link_email")`。

于是 member/unknown 会消耗共享预算并最终 429，admin 不会——跨请求可区分（#176 §3 不变量 1 与 §10 已记录并要求单独立项）。

### 1.2 第一轮复核确认的更深层问题

- **F1**：admin 走只读事务、member/unknown 走含两次 `INSERT` 的写事务（提交写 WAL 并刷盘），latency class 天然不同；
- **F5**：admin 分支位于 `tasks` fence 查询之前，稳态下 member 比 admin 多一次 `SELECT` + 行锁；且 admin 邮箱**可以**持有活跃 token（#176 §7.2 的「签发后晋升」用例）；
- **F2**：`TRUSTED_PROXY_HOPS` 默认 `0`（`src/lib/env.ts:213`）⇒ `getClientIp()` 返回 null ⇒ 目标相关预算被整体跳过，v1 机制在**默认部署下完全失效**；
- **F3**：v1 的 attempt 默认值 20 与来源上限 `REQUEST_CODE_IP_RATE_MAX`（20）同窗口相等，而来源桶先被消费，收敛点不可达；
- **F4**：威胁模型允许多个来源 IP，per-`(digest, IP)` 预算无法约束采样次数，而 dedupe fence 是**按邮箱全局**的，泄漏观测可重复获得。

结论：**只要角色仍在公开请求路径上被读取并决定是否写入，就必然存在 latency class 差异。** 唯一能同时满足「不变量 1 latency class」与「不变量 2 admin 零 token / 零投递任务」的办法，是让公开请求路径**根本不知道角色，也不读取任何与目标邮箱状态相关的行**，把全部判定移入异步处理任务。

### 1.3 跨流程泄漏路径（仍然有效）

`request-code-email-ip:*` 被 `requestLoginCode()`（`src/modules/auth/login-code.ts:116-125`）共享并在耗尽时返回 429，而 `requestLoginCode()` 没有 admin 抑制。因此任何让 Magic Link 的**签发**去推进该共享桶的设计，都可被「先用 Magic Link 烧桶、再用 `POST /api/auth/request-code` 探 429」区分角色。v3 必须让公开请求路径与签发路径都不推进该桶。

---

## 2. 权威来源、术语与范围边界

### 2.1 权威来源与 Issue #184 不变量原文

Issue #184 的 required invariants（逐字引用，作为本规格的判定基准）：

> 1. Repeated public Magic Link requests must not distinguish admin from member/unknown mailboxes through status, response shape, latency class, or relevant rate-limit state observable by the requester.
> 2. **Existing admin mailboxes must still mint no token and enqueue no delivery task.**
> 3. The solution must not send mail to admin accounts, weaken route-level source/IP abuse protection, or allow attackers to cheaply exhaust another user's useful login capacity.
> 4. Member/fan dedupe, retry fencing, and normal Magic Link usability must remain intact.
> 5. Use real PostgreSQL tests for concurrent requests and deterministic limiter-state assertions.

不变量 2 的原文是 **"enqueue no *delivery* task"**，不是 "enqueue no task"。本规格据此设计（§2.3 术语），并在 §2.4 明确取代 #176 中更宽的措辞。

其余权威来源：

- `/tmp/olp184-spec-review-report.txt`（第一轮复核 F1–F12）与 `/tmp/olp184-v2-review-report.txt`（第二轮复核 F184-01–F184-15）。
- `docs/release-v1.2-plan.md` §3 WP1。
- `docs/handoff/harden-s4-auth-rate-limiting.md` §0 不变量（尤其 #2、#8、#10、#11、#12、#16、#17）。
- `docs/handoff/issue-176-admin-magic-link-boundary.md`、`docs/handoff/issue-175-magic-link-session-atomicity.md`。
- `docs/adr/0002-audit-and-event-strategy.md`、`docs/adr/0003-durable-task-and-outbox-boundary.md`。
- `AGENTS.md`（事务/锁边界显式化、真实 PostgreSQL 验证、独立复核、最小完整变更、**禁止把无关数据库操作放进事务或 advisory-lock 临界区**）。
- 基线代码：`src/modules/auth/magic-link.ts`、`src/app/api/auth/magic-link/request/route.ts`、`src/modules/auth/login-code.ts`、`src/lib/rate-limit.ts`、`src/lib/client-rate-limit.ts`、`src/lib/env.ts`、`src/db/schema/index.ts`、`src/modules/tasks/{enqueue,queue-class,handlers,dispatcher,index}.ts`、`src/modules/__invariants__/db-reset.ts`。

### 2.2 术语（规范性）

| 术语 | 定义 | 本设计中的实例 |
|---|---|---|
| **投递任务（delivery task）** | 目的是把一封 Magic Link 邮件送到收件人手中的 durable task：它携带（加密的）token、会调用 SMTP、其存在意味着「已经为该邮箱签发了一条链接」 | **仅** `auth.magic_link_email` |
| **intake（受理）任务** | 角色无关的通用处理任务：在任何角色知识产生之前对**每个**公开请求创建，只携带 `requestId`，不携带 token，**从不调用 SMTP**，其存在**不含任何角色信息** | `auth.magic_link_request` |

**规范约束**：本规格、实现代码、注释、PR 描述与 CHANGELOG **一律不得**把 `auth.magic_link_request` 称为 delivery task / 投递任务，也不得暗示它承担投递语义。任何把二者混称的表述都属于实现缺陷。

### 2.3 本规格更新 #176 的部分

| #176 原文 | #184 v3 结论 |
|---|---|
| §3 不变量 1「跨多次请求仍存在已接受的残余区分信号」 | **取代**：公开请求路径不再读取角色，跨请求在状态、响应体、响应头、latency class、请求者可观察限流状态上均不可区分 |
| **§3 不变量 2「请求时已是管理员的邮箱不生成 `magic_link_tokens`、不生成 `tasks`、不消耗共享 email+IP 发送预算」** | **整句取代其不兼容的时间措辞，并收窄 task 名词**：Issue #184 的权威语义是「在**实际 mint 授权边界**读取为 admin 的现有邮箱不生成 token、不生成投递任务；在 **SMTP 紧前授权边界**读取为 admin 的邮箱不发送；激活/消费边界再次读取为 admin 时不激活、不创建 session」。#176 的「请求时已是管理员」来自同步公开路径；角色无关公开路径既不可能知道该事实，也不得为它持久化 role-dependent decision，否则会重新破坏不变量 1 的结构 latency 等价。因此「公开受理时是 admin、worker mint 前已降级」按 mint 时的当前非 admin 角色处理，可以 mint/投递；这是对 #176 陈旧时间措辞的**明确 supersession**，不是漏保留。反向竞态在 §5.3a 固定。「不生成 `tasks`」收窄为「不生成投递任务 `auth.magic_link_email`」：角色无关 intake 对每个请求都创建、不携带 token、不发信。共享 email+IP 桶则对所有角色都不再消耗。 |
| §5 竞态表中的「0 token；0 task」 | **取代**：读作「0 token；0 投递任务」。admin 每个请求仍会产生 1 行 `magic_link_requests` 与 1 个 intake 任务，与 member/unknown 完全相同 |
| §4.1「请求期守卫……在 email+IP rate limiter 之前」 | **取代**：请求期守卫整体移出公开路径，进入 intake 任务；守卫语义（角色、dedupe、fence、锁顺序）逐条保留 |
| §4.1「请求期检查是 best-effort 优化，不是最终授权边界」 | **保留**：消费期守卫仍是强制安全边界 |
| §10「守卫顺序保留慢速限流区分信号，由后续 Issue 跟踪」 | 本 Issue 即该后续项，且已消除 |
| **§2.2 保证 1「返回与普通抑制路径相同的 `{ suppressed: true }`」** | **取代**：`RequestMagicLinkResult` 不再有 `suppressed` 字段（§5.2）。该保证的**目的**——对外响应形状统一——由 v3 更强地满足：路由对所有角色、所有内部结果恒返回同一个 `200 accepted`，且模块返回值已不再携带任何可区分信息 |
| **§4.1「请求期管理员抑制**不写 `app_events`**，避免在持久管理遥测中留下邮箱角色标记」** | **取代**：v3 对**每个**请求写一条 `magic_link_requested`（§5.10）。#176 的顾虑是「事件的**存在**本身标记该邮箱是管理员」；v3 下该事件对 admin / member / unknown 一律产生且 payload 相同，因此不再是角色标记。原顾虑被消除，而不是被接受 |
| **§7.1 测试 1–3（可执行断言）** | **取代**：测试 1 的「0 app event」改为「恰好 1 条 `magic_link_requested`，且与 member/unknown 的 payload 形状相同」；测试 2 的 `{suppressed:true}` 断言改为「恒定 `200 accepted` 且 0 token / 0 投递任务」；测试 3 的「两个请求**在 advisory lock 上串行**」被**反转**为 §10 切片 1 测试 1 的「公开路径**不**串行、不持任何按邮箱锁」。三条都必须**改写而非删除**，且断言强度不得降低（§10「必须保持绿的既有回归」） |

#176 的消费期角色锁（§4.2）、消费期事件白名单（§4.4）与 GET 页面（§4.5）语义保留；其 token 终态（§4.3）由本规格增加 delivery lifecycle，但消费原子性与公开 invalid 语义不变。实现 PR 必须在 `docs/handoff/issue-176-admin-magic-link-boundary.md` 顶部加一行指针，注明其 **§2.2 保证 1、§3 不变量 2 的「请求时」时间措辞与 task 范围、§4.1 的请求期角色守卫及 `app_events` 句、§4.3 token lifecycle、§5 表格的「task」措辞、§7.1 测试 1–3** 均已被本文件 §2.3 / §5.3a / §5.5a 取代或收窄——否则两份 handoff 会长期互相矛盾。

### 2.4 明确不变更

GET 确认页、confirm Route、#175 的消费事务与 session/cookie 边界、`requestLoginCode()` 与 `/api/auth/request-code`、`verify-code`、OAuth、管理员密码登录、`src/lib/rate-limit.ts`、`src/modules/restore/neutralize.ts`、`AppEventType`、公开错误类型、zh/en/ja 文案：全部零改动。`verifyMagicLinkToken()` / `consumeMagicLinkToken()` 必须增加 active-delivered 谓词，`deliverMagicLinkEmailTask()` 必须按 §5.3a 改成 delivery-aware 激活协议；除这些明确变化外，其授权、事务、session/cookie、SMTP 错误分类与任务退避语义保持不变。

（`src/modules/auth/rate-limit-policy.ts` **不在**本列表内：§5.8 要求在其中新增一个纯函数助手。它仍不新增任何 limiter key。）

（`src/modules/site/index.ts` 的 `setupSite()` 与 `src/modules/auth/admin-account.ts` 的 `changeAdminEmail()` 同样**不在**本列表内：§5.3b 要求在它们的既有事务内实施晋升围栏。围栏只增加「取 advisory lock → 检投递预留 → 取消 pending candidate」三步，不改变站点初始化语义、密码哈希、`emailTaken` 冲突处理或既有审计事件。上文「管理员密码登录」零改动仍然成立——登录路径不写 `role`/`email`。`src/modules/mail/index.ts` 只新增常量导出，超时数值与传输行为零改动。）

---

## 3. 威胁模型

**攻击者能力**：任意公开 HTTP 请求；**任意数量的来源 IP**；精确测量状态码、响应体、响应头与端到端延迟；对同一邮箱无限次重复观测（只受各来源自身的来源级门禁约束）；并发请求；探测 `/api/auth/request-code` 等其它公开端点。

**攻击者不能**：读取目标邮箱、服务端日志、`app_events`、数据库、任务队列或进程内 limiter。

**目标**：判定任意邮箱属于 `admin` / `member` / `unknown`；或廉价剥夺受害者的可用登录能力。

**不在模型内**：拥有目标邮箱访问权者；能读服务端遥测的内部人员；多实例内存 limiter 的分布式绕过（S4 §0 #17 既有约束）。

---

## 4. 安全保证与非目标

### 4.1 保证（G）

- **G1 状态 / 响应体 / 响应头不可区分**：`POST /api/auth/magic-link/request` 对 admin / member / unknown 在任意重复次数、任意并发、任意来源 IP 数量下返回逐字节相同的 `200 {"ok":true,"data":{"accepted":true}}` 与相同响应头集合。
- **G2 latency class 相同**：公开请求路径对所有角色执行**完全相同的语句序列、相同数量的数据库往返、相同的写事务与提交类别**，不获取任何按邮箱的锁，不读取 `users` / `magic_link_tokens` / `tasks`。请求处理时间是「请求本身」的函数，与目标邮箱的角色和状态**无函数依赖**（§5.2 逐项列举全部往返，含事务外的两次）。
- **G3 请求者可观察限流状态不可区分**：公开路径只消费既有**来源级**桶（`request-code-ip:<ip>` / `request-code-unresolved`），推进量只依赖攻击者自己的来源身份；不存在任何目标相关的、请求者可观察的限流状态。
- **G4 无跨流程 oracle**：Magic Link 的请求与签发路径都不读写 `request-code-email-ip:*`。
- **G5 admin 边界零 Magic Link 副作用**：在 worker 的实际 mint 授权边界读取为 admin 的邮箱不产生 `magic_link_tokens` 行、**不产生投递任务 `auth.magic_link_email`**；在 SMTP 紧前边界读取为 admin 则不发送；在激活/消费边界读取为 admin 则不激活、不创建 session。更强的**排序不变量**（§5.3b）：任一晋升事务提交之后，协议不再为该邮箱发起新的 SMTP 调用，也不会把此前的在途投递激活为可消费链接——晋升与发送由持久投递预留可线性化地互斥，而不是靠发信后的补救检查。admin 与其它所有角色一样产生 1 行 intake 与 1 个 intake 任务（§2.2 / §2.3）。公开受理时的历史角色不是权威判据，且不得被公开路径读取或持久化；全部晋升/降级线性化语义见 §5.3a。
- **G6 member / unknown 不可区分**：公开路径完全不读 `users`；worker 对 member 与 unknown 执行相同分支与相同写入。
- **G7 默认部署即安全**：G1–G6 **不依赖** `TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_HEADER` 的配置，在 `identity.kind === "unresolved"`（出厂默认，`env.ts:213`）下同样成立。
- **G8 多 IP 采样无收益**：公开路径的可观察输出与目标状态无函数依赖，增加来源 IP 只增加请求量，不增加任何关于角色的信息。
- **G9 来源级防护不减弱**：路由层来源门禁保持原样，仍是唯一返回 429 的门禁。
- **G10 delivery-aware 定向拒绝边界（精确、有限）**：为替换请求创建 pending token、SMTP 失败、worker 在 SMTP 前后崩溃、租约被抢占或重复发送，均**不得使此前已投递且尚未自然过期、尚未消费的 active token 失效**。只有在 SMTP 已成功返回且当前任务仍持有效 fence 的激活事务中，才可原子激活替代 token 并 supersede 旧 active token。因而攻击者不能通过反复请求或制造投递失败，提前耗尽受害者**已经持有的、仍在自然有效期内**的登录能力。
  本保证不声称：在旧 token 已自然过期或已消费后仍必有可用链接；SMTP 至少一次语义下绝不重复发信；队列/SMTP 永久故障时能产生新链接。`S ≤ TTL` 的配置告警仍保留，但仅用于限制成功激活后的发送频率，不能被描述为「任意时刻必有链接」（§8.1）。

### 4.2 非目标（NG）

- **NG1 不声称全局账号枚举安全**：邮箱验证码、OAuth、公开页面与邮件投递本身的枚举性质不在范围内。
- **NG2 不解决多实例内存 limiter 一致性**（S4 §0 #17）。
- **NG3 不改变管理员的其它 passwordless 面**（#176 §2.3 继续有效）。
- **NG4 不使用延迟填充 / 人工抖动 / 常量时间包装**：v3 通过**结构等价**达成 latency class 相同。
- **NG5 不把 `app_events` 事务化**。
- **NG6 不重做 #175 / #176**。
- ~~**NG7 不引入新的任务队列类别**~~ —— **v3 修订后撤销**。第三轮复核（F-B）证明既有 `default` 类已承载 `publish_post`、`payment_provider_event.dispatch` 与 `subscription.reconcile`，且 `claimOneTaskForClassBranch` 的排序是 `run_after ASC, priority ASC, id ASC`（`src/modules/tasks/index.ts:408`）——`run_after` 支配排序，`priority` 只在时间戳相同时才起作用。因此把 intake 放进 `default` 会让未认证攻击者制造的 intake 积压**先进先出地排在后创建的支付回调派发与定时发布之前**。v3 改为给 intake **专用队列类别 + 每批上限**（§5.3），这是唯一能同时保护 `transactional`（投递、验证码）与 `default`（支付、发布）两侧租户的方案。

---

## 5. 设计

### 5.1 总体形态：角色无关的持久 intake + 通用处理任务

```text
公开请求（角色无关、目标状态无关）
  └─ INSERT magic_link_requests(1 行)  +  enqueueTask("auth.magic_link_request")  ─┐
                                                                                   │ 同一事务
异步 worker —— intake 任务，唯一知道角色的地方（不是投递任务）                        │
  └─ auth.magic_link_request  ←───────────────────────────────────────────────────┘
       ├─ mint 边界当前 admin → 只标记 resolved，不 mint、不入队投递任务、不发信
       ├─ dedupe/fence   → 只标记 resolved；不触碰既有 active token
       ├─ mint 预算耗尽  → 只标记 resolved
       ├─ intake 超龄    → 标记 resolved + 发出可观测告警
       └─ 其它           → INSERT pending/inactive token + enqueueTask("auth.magic_link_email")
                                                                      └─ SMTP 成功
                                                                         └─ 围栏事务：激活 replacement
                                                                            + supersede 旧 active token
```

**为什么满足 Issue #184 不变量 2**：不变量 2 的原文是 "mint no token and enqueue no **delivery** task"（§2.1）。在实际 mint 授权边界读取为 admin 时，本次 request 的 `magic_link_tokens` 与 `auth.magic_link_email` 增量恒为 **0**；SMTP 边界读取为 admin 时发送增量为 0。`auth.magic_link_request` 按 §2.2 的定义**不是**投递任务：它对每个请求都创建、在任何角色知识产生之前就已写入、不携带 token、从不调用 SMTP，其存在与否不含任何角色信息。#176 中更宽的 task 范围与不兼容的 request-time 时间措辞均由 §2.3 显式取代。

### 5.2 公开请求路径（逐语句固定）

路由 `src/app/api/auth/magic-link/request/route.ts` **逻辑不变**：

```text
assertContentLengthWithinLimit
→ resolveClientRateLimitIdentity（unresolved 且 production 时节流告警）
→ 来源门禁 rateLimit(request-code-ip:<ip> | request-code-unresolved)   ← 唯一 429
→ readJsonWithLimit + zod schema
→ normalizeEmail + validateNormalizedEmail
→ assertTurnstile
→ requestMagicLink()
→ 恒定 jsonOk({ accepted: true })
```

**返回类型**：`requestMagicLink()` 改为 `Promise<void>`。基线的 `{ suppressed, tokenId? }` 与 v2 草案的 `{ requestId }` 都无法同时描述发布门两侧的两条路径（flag-off 走基线同步逻辑，根本不存在 `requestId`），而路由本就忽略返回值（`route.ts` 只 `await` 后返回固定 accepted）。用 `void` 消除该矛盾，也顺带杜绝「返回值携带可区分信息」这一类回归。`RequestMagicLinkResult` 类型随之删除。

`requestMagicLink()` 目标实现：

```ts
const normalized = normalizeEmail(email);
if (!tryGetMagicLinkKeys()) throw new ApiError(500, "magicLinkNotConfigured"); // 目标无关
const smtp = await getSmtpConfig();                                            // 目标无关（1 次未缓存查询）
if (!smtp.configured) throw new ApiError(500, "mailNotConfigured");            // 目标无关

// 发布门（§9.2）。flag-off 时走基线同步分支，其行为与 af24c6f 完全一致，
// 因此本节以下的结构等价断言只适用于 flag-on 路径。
if (!getEnv().MAGIC_LINK_INTAKE_ENABLED) {
  await legacySynchronousRequestMagicLink(normalized, meta);  // 基线逻辑，原样保留
  return;
}

const requestId = randomUUID();   // 应用侧生成，使两条 INSERT 相互独立且形状固定
await getDb().transaction(async (tx) => {
  await tx.insert(magicLinkRequests).values({
    id: requestId,
    email: normalized,
    locale: meta?.locale ?? null,
    redirectPath: normalizeMagicLinkRedirectPath(meta?.redirectPath),
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
  });
  await enqueueTask(tx, {
    kind: "auth.magic_link_request",
    dedupeKey: `auth-magic-link-request:${requestId}`,
    payload: { version: 1, requestId } satisfies MagicLinkRequestTaskPayload,
  });
});
await recordEvent("magic_link_requested", {                                    // 1 次事务外插入
  requestId,
  emailDigest: hmacSha256WithPurpose("auth-log-email", normalized),
});
```

**结构等价断言（G2 的可评审依据）**——**在 `MAGIC_LINK_INTAKE_ENABLED=true` 时**，公开路径对任意输入恒定为（flag-off 路径等同基线，不具备本表性质，这正是 §9.2 把 flag-off 定为**限时**发布窗口、并在 §11.7 记为已知暴露的原因）：

| 维度 | 值 |
|---|---|
| 按邮箱 advisory lock | **0 次**（不再获取） |
| `users` 读取 | **0 次** |
| `magic_link_tokens` 读取 / 写入 | **0 次** |
| `tasks` 读取 | **0 次** |
| **事务内**数据库往返 | `BEGIN` + 2 × `INSERT` + `COMMIT`，**恒定 4 次** |
| **事务外**数据库往返 | `getSmtpConfig()` → `getStoredGroup()` 的 1 次未缓存 `select … from app_settings`（`config/smtp.ts` → `config/store.ts`），+ 提交后 `recordEvent()` 的 1 次 `insert`。**共 2 次，均与目标邮箱无关**（前者不含 email 参数，后者只写摘要且对每个请求都发生） |
| 每请求总往返 | **恒定 6 次**，与角色 / 邮箱 / 并发无关 |
| 事务类别 | **始终是写事务**，提交始终写 WAL 并刷盘 |
| 行锁竞争 | 无：两条 `INSERT` 的主键与 `dedupe_key` 都由本请求新生成的 UUID 决定，任意两个并发请求（同邮箱或不同邮箱）都不会互相阻塞 |
| 外部 I/O | 无（SMTP 全部在既有投递任务中） |
| 分支 | 无角色分支、无目标状态分支 |

因此只存在两个 latency class：`L0`（来源门禁 429，不进入模块）与 `L1`（其余全部请求）。`L0` 只依赖攻击者自身来源桶。admin / member / unknown 在**任何**场景下都落在同一个 `L1`。这是对 F1 与 F5 的**结构性消除**。

`enqueueTask` 的 `onConflictDoNothing({ target: tasks.dedupeKey })` 在此恒不冲突（dedupeKey 含新生成 UUID），不引入数据依赖的分支代价。

路由本就忽略返回值，故路由逻辑零改动（其测试需同步更新，见 §10 切片 5）。

### 5.3 `auth.magic_link_request` intake 任务

**注册**：新增专用队列类别 `auth_intake`，并在 `src/modules/tasks/queue-class.ts` 中登记

```ts
// TASK_QUEUE_CLASSES 增加 "auth_intake"
"auth.magic_link_request": { queueClass: "auth_intake", priority: 0 },
```

**为什么必须用专用类别，而不是 `transactional` 或 `default`**（F184-08 + 第三轮 F-B）：

dispatcher 每 `TASK_POLL_INTERVAL_MS = 10_000` ms 处理至多 `TASK_BATCH_SIZE = 20` 个任务（`src/modules/tasks/index.ts:31-32`），按类保留名额（`env.ts:49-51,59`：transactional 保留 8、notification 最低 2、default 最低 2、maintenance 至多 2）。关键事实：`claimOneTaskForClassBranch` 的排序是 `ORDER BY run_after ASC, priority ASC, id ASC`（`src/modules/tasks/index.ts:408`）——**`run_after` 支配排序，`priority` 只在时间戳相同时才是 tie-break**。因此在同一类别内，先创建的 intake 会**严格先进先出地**排在所有后创建的任务之前，`priority` 数值改变不了这一点。

| 候选类别 | 既有租户（`queue-class.ts` `QUEUE_DEFAULTS`） | 放入 intake 的后果 |
|---|---|---|
| `transactional` | `auth.login_code_email`(0)、`auth.magic_link_email`(0)、`email`(10)、`subscription.renewal_reminder`(10) | intake 洪泛排在**它自己 gate 的投递任务**之前，并拖慢 §2.4 承诺不受影响的验证码 fallback |
| `default` | `publish_post`(20)、`payment_provider_event.dispatch`(20)、`subscription.reconcile`(30) | intake 洪泛延迟**支付回调派发**与**定时发布**——未认证攻击者即可影响计费与内容上线 |
| **`auth_intake`（新增）** | 仅 intake | FIFO 积压只发生在自己类内；共享 batch 的剩余槽竞争仍须显式建模 |

因此 v3 撤销 NG7（§4.2），新增 `auth_intake` 类别并给它一个**每批上限** `TASK_AUTH_INTAKE_MAX_PER_BATCH`（默认 `4`，范围 0–20）。在 dispatcher 中：

1. 在 `claimClass` 内按与 `TASK_MAINTENANCE_MAX_PER_BATCH` 同形状的分支，于 claim **之前**拒绝超过 intake cap 的领取；不得先领取再退回；
2. 把 `auth_intake` 加入 claim order 时，必须保留既有 `transactional` reserved、`notification` minimum 与 `default` minimum 的 deficit 保护。只要相应类别有可领取任务，intake 不得使其实际领取数低于配置值；
3. 常规剩余槽的顺序把 `auth_intake` 放在 `transactional` / `default` / `notification` 之后、`maintenance` 之前。这样 intake 能前进但不优先夺取机会容量；它与 maintenance 都没有最低名额；
4. `assertRuntimeSecurity()` 仍校验三项既有 reserved/minimum 之和不超过 batch；`TASK_AUTH_INTAKE_MAX_PER_BATCH` 是上限而非 reservation，**不**加入该求和。

专用类消除了与支付/投递任务的**同类 FIFO 头阻塞**，但 intake handler 仍实际消耗共享 batch 槽与数据库资源，不能声称其它类别完全不受影响。定量边界见 §8.2。

`priority: 0` 保留，但**它在此处是惰性的**——同类内只有 intake 一种 kind，且排序由 `run_after` 支配。§10 测试 4 断言的是「类别 = `auth_intake`」这一隔离决策，`priority` 只是附带固定。

新类别需要：`TASK_QUEUE_CLASSES` 增加成员、migration 中 `alter table tasks drop constraint tasks_queue_class_check` 后按新集合重建、dispatcher 的 `order` 数组与名额逻辑接入、以及 §5.8 的新变量。`queue_class` 列本身是 `text` + check 约束（`src/db/schema/index.ts` `tasks` 定义），不是 PostgreSQL enum，故只需替换约束，无需类型迁移。

**处理函数** `resolveMagicLinkRequestTask(payload, fence)`，主事务内**不含任何外部 I/O、也不含任何与本邮箱无关的数据库操作**：

```text
transaction(tx)   ← 主事务
├─ 1. claim 校验：SELECT tasks WHERE id = fence.taskId ... FOR UPDATE
│        ∧ kind = 'auth.magic_link_request'
│        ∧ status = 'processing' ∧ locked_by = fence.lockToken ∧ lease_until > now()
│        未命中 → note「claim stale」（成功 no-op）
│        该行锁必须持有到提交（理由见下「task 行锁」）
├─ 2. SELECT magic_link_requests WHERE id = payload.requestId FOR UPDATE
│        不存在 → logger.warn({ requestId }) + note「request row missing」（成功 no-op；持久状态不变量破坏）
│        resolved_at 非空 → note「already resolved」（成功 no-op，幂等重试出口）
├─ 3. pg_advisory_xact_lock(hashtext(request.email))
├─ 4. 重新校验 claim（等锁期间租约可能被抢占）—— 与 deliverMagicLinkEmailTask 同一模式
├─ 5. 首次执行超龄：task.attempts = 1
│        ∧ created_at < now() - MAGIC_LINK_REQUEST_MAX_AGE_MINUTES
│        → 标记 resolved，不 mint，并发出 §5.9 的超龄告警（可观测终态）
├─ 6. SELECT magic_link_tokens 未终态行 ... FOR UPDATE         ← active 与 pending token
├─ 7. SELECT users role ... FOR UPDATE                        ← user（token → user 顺序）
├─ 8. 判定（任一命中即「标记 resolved，不 mint」）：
│      a. role === 'admin'
│      b. pending token 存在且其投递任务 status ∈ {pending, processing, failed}
│      c. pending token 存在但缺投递任务 → logger.warn + 保守抑制
│      d. 最近一次 delivered_at 在 REQUEST_CODE_SEND_DEDUPE_SECONDS 窗口内
│      e. request.ip 非空 且该 (email, ip) 窗口内 minted 计数 ≥ 上限（§5.5）
├─ 9. 对 task 已 dead/succeeded 但仍 pending 的残留 candidate 先转 cancelled
├─ 10. 否则 mint pending/inactive replacement（列传播见下）；不得更新旧 active token
├─ 11. UPDATE magic_link_requests SET resolved_at = now()
└─ 提交
清理（§5.7）在主事务**提交之后**、以**独立事务**执行，失败只记日志
```

**第 10 步的列传播（F184-10，规范性）**：基线从活的 HTTP 请求读取这些字段（`magic-link.ts:262-277`）；v3 中请求早已结束，全部字段**必须**取自 intake 行：

| `magic_link_tokens` 列 | 来源 |
|---|---|
| `email` | `request.email`（已规范化） |
| `redirect_path` | `normalizeMagicLinkRedirectPath(request.redirect_path)` —— **再次经过 allowlist**，防止历史行绕过后来收紧的规则 |
| `ip` | `request.ip` |
| `user_agent` | `request.user_agent` |
| `expires_at` | pending 时先写占位上界；真正激活时重置为 `addMinutes(activationNow, MAGIC_LINK_TTL_MINUTES)`，TTL 从**成功投递后的激活时刻**起算 |
| `token_hash` / `key_id` | 本次新生成（`keys.current`） |
| `delivery_state` / `delivered_at` | 固定为 `pending` / `null`；只有 §5.3a 激活事务可改为 `active` / `activationNow` |

`MagicLinkEmailTaskPayload.locale` **必须**用 `SUPPORTED_LOCALES` 重新校验：`request.locale` 经 `text` 列往返后是任意字符串，而投递任务的 payload zod schema 是严格的（`tasks/handlers.ts:104-109`），非法值会抛 `PermanentTaskError` 并使投递任务立即 dead-letter。

**校验失败时必须把 `locale` 键整个从 payload 中省略，而不是写入一个显式默认值**（F-K）。理由：`MagicLinkEmailTaskPayload.locale` 本就是可选字段（`magic-link.ts:46`，schema 侧 `.optional()`），`deliverMagicLinkEmailTask` 把 `payload.locale` 原样传给 `sendMagicLinkEmail`，由后者在 `undefined` 时解析自己的默认值（`magic-link.ts:392-396`）。基线传的是 `meta?.locale`，同样可能是 `undefined`。写入显式默认值会把「未指定」变成「明确指定」，属于行为变更；省略键则与基线逐字节等价。§10 测试 10 断言的是**键不存在**，不是键等于默认值。

**第 2 步为什么必须 `FOR UPDATE`（F-N，规范性）**：§5.7 的清理谓词已经把删除限制在 `resolved_at is not null` 且使用 `for update skip locked`，因此常规清理不可能选中本次处理的未解析行。但该保护完全依赖清理端谓词的正确性，而 handler 在第 3 步会因等待 email advisory lock 而让出任意长的时间窗。锁定 intake 行使**读取方**也持有证据：任何并发删除（包括未来新增的、谓词更宽的运维清理）都必须先等这把行锁，而带 `skip locked` 的清理直接跳过。没有它，一次「读到行 → 等锁 → mint → 写回 `resolved_at`/`minted_at` 影响 0 行」的交错会让一次**已经发生的 mint** 退出 §5.6 的持久预算，从而放行超出配置上限的认证邮件。行锁与后续 advisory lock 的顺序固定为 `task → magic_link_requests → advisory(email)`，清理只取 `magic_link_requests` 行锁且 `skip locked`，不构成环。

**task 行锁（F-O，规范性）**：第 1 步的 claim 校验**不得**是普通 `SELECT`。基线的所有竞争性 task 状态转换都取同一行的行锁：租约过期重新 claim（`claimOneTaskForClassBranch` 的 candidate CTE）与 `sweepExpiredFinalAttemptTasks()`（`tasks/index.ts:319,336`）都是 `FOR UPDATE SKIP LOCKED`，`markTaskFailedInternal()` 是 `.for("update")`（`:513`），`markTaskDead()` 是按 `status='processing' ∧ locked_by` 的条件 `UPDATE`（隐式行锁）。因此 handler 事务只要以 `FOR UPDATE` 持有该行直到提交，前两者会**跳过**它、后两者会**等待**它：不存在「复检通过之后、写入之前租约被抢走」的窗口。普通 `SELECT` 不提供这一点——它读到的是快照，抢占方可以在复检与写入之间提交。同一要求逐字适用于 §5.3a 的事务 A 与事务 B（后者是 load-bearing，见 §5.3a）。

**锁顺序**：`task → magic_link_requests → advisory(email) → magic_link_tokens → users`，与消费、验证及 §5.3a 激活事务的 `token → user` 顺序兼容，也与 §5.5a reconciler 的 `task → token` 同向（两者都先 task、后 token，且 reconciler 不取 advisory lock），保持 #176 §4.1 的反死锁结论。worker 与消费路径之间、worker 与 worker 之间都不会形成反向等待。

**授权与围栏**：worker 不接受任何调用方传入的角色或身份；角色只在第 7 步由数据库读出。claim 校验 + 等锁后复检的双重围栏与 `deliverMagicLinkEmailTask()` 完全一致；租约过期或被重新 claim 的陈旧执行必须成为**成功 no-op**，不得 mint。

**为什么不在 intake 任务内直接发信**：保持 `auth.magic_link_email` 的独立 fence、加密 payload、SMTP 事务外调用与重试分类语义（不变量 4、ADR 0003）。v6 改变的是 supersede 的时点：从 mint 事务移到 SMTP 成功后的激活事务。代价是投递比基线多等一个 dispatcher 周期（§11.3）。

### 5.3a `auth.magic_link_email`：SMTP 后围栏激活

投递任务 payload 必须继续携带 `tokenId` 与加密 token；`tokenId` 同时是 replacement candidate 身份。新增严格字面量 `deliveryProtocol: 2`（在加密 payload 内）作为**不可推断、不可省略**的 delivery-aware 标记。migration 前任务、旧实例与发布门关闭的 baseline 分支 payload 均没有该字段，定义为 legacy protocol 1。handler 必须先按 payload 分流：

- 无 `deliveryProtocol`（legacy v1）：完整沿用基线 SMTP/fence/supersede 行为；不得进入 pending/active recovery 判定。这样 migration 前在途任务与 Phase 1 baseline 请求不会被 active backfill 误判为「已激活」而跳过 SMTP。
- `deliveryProtocol === 2`：candidate 必须由 intake 显式写为 pending/null，执行下列 delivery-aware 协议；只有 v2 task 可进入 active-delivered crash recovery。
- 其它值：`PermanentTaskError`，不得猜测协议或发送。

v2 处理顺序固定为：

```text
1. 事务 A（围栏准备 + 投递预留）
   ├─ SELECT tasks WHERE id = fence.taskId FOR UPDATE（持有到提交，§5.3「task 行锁」）
   │    校验 processing + locked_by + lease_until > now()
   ├─ 以 payload 中的规范化 email 取得 advisory(email)
   ├─ 等锁后重新校验 task claim（同一已锁定行）
   ├─ SELECT candidate FOR UPDATE
   ├─ task/token/email/protocol-v2 不对应 → stale/corrupt no-op，不 SMTP
   ├─ candidate 已 active 且 delivered_at 非空
   │    → crash-after-activation 恢复：不 SMTP、不 supersede、不重发 event；提交后 task succeeded
   ├─ candidate 为 superseded/cancelled/consumed → terminal no-op，不 SMTP
   ├─ 否则 candidate 必须是 pending、未消费、未 supersede
   ├─ SELECT users role FOR UPDATE；此时为 admin → candidate cancelled
   │    （并清空预留）、成功 no-op、绝不 SMTP
   ├─ 写投递预留：candidate.delivery_reservation_until
   │    = now() + MAGIC_LINK_DELIVERY_RESERVATION_SECONDS       ← §5.3b 晋升围栏
   └─ 提交（预留与「已读到 non-admin」在同一事务内原子生效）
2. SMTP（事务外）
   └─ sendMagicLinkEmail(candidate token)
      调用整体受 mail transporter 的 15 s + 15 s + 45 s 超时预算约束（§5.3b）
3. SMTP 抛错
   └─ 不改 candidate、不改旧 active token；沿用瞬时/永久错误分类和任务重试/dead-letter
      预留保持原值，自然到期；不提前清空（清空会给晋升开一个无预留窗口）
4. SMTP 成功返回后，事务 B（唯一激活点）
   ├─ SELECT tasks WHERE id = fence.taskId FOR UPDATE（持有到提交）
   │    校验 processing + locked_by + lease_until > now()
   ├─ 重新取得同一邮箱 advisory lock
   ├─ 等锁后重新校验 task claim（同一已锁定行）
   ├─ SELECT 该邮箱**全部** magic_link_tokens 行 FOR UPDATE（不按状态过滤，见下）
   ├─ candidate 仍为 pending、未消费、未 supersede、未被 cleanup
   ├─ candidate.delivery_reservation_until > now()
   │    已过期 → 不激活，candidate → cancelled，terminal 成功 no-op（§5.3b 残余）
   ├─ 投递期消费检查：不存在同邮箱 token 满足
   │    consumed_at IS NOT NULL AND consumed_at >= candidate.created_at
   │    命中 → candidate → cancelled，terminal 成功 no-op，不激活、不记 event
   ├─ monotonic latest-candidate：不存在 (created_at, id) 更大的 eligible replacement
   │    （delivery_state IN ('pending','active')；不含 consumed/superseded/cancelled）
   ├─ 再读 users role FOR UPDATE；若已变为 admin，则 candidate → cancelled，绝不激活
   ├─ candidate → active，delivered_at = now，expires_at = now + TTL，
   │    delivery_reservation_until = null
   ├─ 其它 active token → superseded，superseded_at = now
   └─ 提交；随后才 best-effort recordEvent("magic_link_sent")，最后任务 succeeded
```

**事务 B 为什么锁该邮箱的全部 token 行，而不是只锁未终态行（F-P，规范性）**：`consumed_at` 是**终态**，因此「只锁未终态行」的旧写法既看不到、也不会与并发消费串行。于是下列交错成立：旧 active token 的消费事务先提交并插入 session，事务 B 随后照常激活 replacement，用户手里就同时有一个已用 session 与一个仍可消费的新链接——第二次消费会插入**第二个** session。这直接推翻 §7 的「最多一个 session」与测试 26i 的 `total session ≤ 1`。消费路径不取 email advisory lock（§7），所以唯一可用的串行化手段就是共同的 token 行锁：事务 B 无状态过滤地锁定该邮箱全部行后，消费要么已提交（B 读到 `consumed_at` 并取消 candidate），要么必须等 B 提交（届时旧 token 已 superseded，消费返回 invalid）。两种串行结果都恰好产生 ≤1 个 session。

比较基准取 `candidate.created_at` 而不是「本次投递开始」：candidate 自 mint 起就是这一次替换的身份，任何在它存在期间发生的消费都使这次替换变得多余。早于 `candidate.created_at` 的历史消费不影响激活。锁集合的规模由 §5.7 的 token 清理与保留期约束，并由既有 `magic_link_tokens_email_created_idx`（`schema/index.ts:92`）支撑；本 Issue 不为它新增索引。

事务 A 不是「预留激活」：它只能写 candidate 自己的 `delivery_reservation_until`（§5.3b）或在读到 admin 时把 candidate 置 `cancelled`，**不得**改动 candidate 的 `delivery_state`/`delivered_at`/`expires_at`，更不得修改旧 active token。预留只约束**晋升路径**，不使 candidate 可验证。SMTP 成功也不是充分条件；只有事务 B 提交才使新链接可被 verify/consume。事务 B 任一步失败必须整体回滚，旧 active token 保持原状，任务按现有瞬时故障语义重试。`magic_link_sent` 只能在激活提交后 best-effort 产生；不能在 SMTP 调用前产生，也不能在 stale/cancelled/monotonic-candidate 失败时产生。ADR 0002 / NG5 禁止把 `app_events` 强塞进激活事务，因此崩溃可能造成事件缺失或重复；数据库 token/task 状态才是正确性来源，不得用事件围栏激活。

**角色判定的权威时点与全部竞态（取代 #176 的 request-time temporal wording）**：

1. 公开受理路径从不读角色，也不保存角色快照/抑制位。受理时是 admin、但在 intake 取得 `users ... FOR UPDATE` 前已降级为非 admin：worker 以当前非 admin 角色授权 mint；可创建 token、投递任务并发送。这是角色无关公开路径的必要语义，不是安全遗漏。
2. intake 的 mint 边界读到 admin：本 request 直接 resolved，0 token、0 投递任务、0 SMTP；随后降级不得复活该已解析 request。
3. mint 时为非 admin、在事务 A 读取前晋升：candidate 已存在，但事务 A 将其 `cancelled`，0 SMTP；随后降级不得复活 candidate。
4. 事务 A 读取非 admin 后、SMTP 调用前晋升：**该交错被 §5.3b 的投递预留排除**。事务 A 在同一事务内既锁定读到 non-admin、又写下未到期的 `delivery_reservation_until`；任何晋升路径都必须先取同一把 email advisory lock 并观察该预留，因此在预留有效期内**无法提交**晋升。晋升只能线性化在事务 A 之前（→ 第 3 项）或事务 B 之后（→ 第 5 项）。
5. SMTP 后、事务 B 读取前晋升：只有在事务 B 已提交并清空预留、或预留自然到期之后才可能发生。前者是正常成功路径：邮件在晋升之前就已线性化地发给一个当时非 admin 的邮箱，链接随后由消费期 admin guard 拒绝，0 session。后者见 §5.3b 的残余边界。若晋升发生在事务 B 已锁定并读取 non-admin 之后，则本次激活可先提交，晋升随后生效；消费期 admin guard 仍保证 0 session。这是锁定读取的线性化结果，不得声称任意并发晋升时点都物理 0 token/SMTP。
6. 任一 admin check 已将 request resolved 或 candidate cancelled 后再降级：状态保持终态，不重开、不重发；用户必须新请求。受理时非 admin、worker 前晋升则适用第 2 项，严格 0 token/投递/邮件。

因此 Issue #184 不变量 2 的 “Existing admin mailboxes” 以**实际 mint / delivery 授权边界的当前锁定角色**为准，而不是已结束的公开请求时刻。实现、测试、PR 与 CHANGELOG 不得继续声称保留 #176 的「请求时 admin 永不 mint」措辞。

配合 §5.3b，可陈述的**排序不变量**是：对任一邮箱 E，若一次晋升事务把 E 变为 admin 并提交于 `t_p`，则本协议在 `t_p` 之后**不会**为 E 发起新的 SMTP 调用；已发生的 SMTP 调用全部线性化于 `t_p` 之前，且其中任何一次都不会在 `t_p` 之后被激活为可消费链接。这正是 Issue #184 不变量 3 与 AGENTS.md「已失效的 durable work 不得产生外部副作用」所要求的强度，而不是 v6 的「先发信、事后由事务 B 补救」。

**崩溃与至少一次投递**：

- SMTP 前崩溃：重试发送；旧 active token 不变。
- SMTP 失败（包括 permanent）：handler 抛出时 candidate 保持 pending、旧 active token 不变；只有 dispatcher 随后提交 `dead`（或 final-attempt sweep 提交 `dead`）后，§5.5a 的 post-finalization hook / reconciler 才可回收 pending candidate。
- SMTP 已接受、事务 B 前崩溃：无法知道邮件是否到达；重试允许再次发送**同一 candidate**，随后仅一次激活。禁止创建第二个 token 来「补偿」。
- SMTP 后租约过期/被重新 claim：旧执行的事务 B 围栏失败并成功 no-op；新 claim 重发同一 candidate 后激活。旧执行绝不得凭 SMTP 成功绕过 fence。
- 事务 B 提交后、任务标记 succeeded 前崩溃：重试在事务 A 的 active-delivered 分支把任务幂等完成，**不得再次 SMTP**、不得再次 supersede、不得重发 event。若崩溃发生在激活提交后、`recordEvent` 前，则 `magic_link_sent` 可缺失；它不作为登录正确性证据。

因此协议提供数据库状态与副作用的 at-least-once/幂等收敛，不宣称 SMTP exactly-once。重复邮件可能发生，但它们包含同一 token；candidate 激活后均指向同一条可用链接。

**verify / consume 查询**：所有按 hash/id 取得可验证 token 的查询必须追加 `delivery_state = 'active' AND delivered_at IS NOT NULL`；`pending`、`cancelled`、`superseded` 永远返回与无效 token 相同的公开结果。消费事务继续锁 token 后锁 user；由于事务 B 无状态过滤地锁定该邮箱**全部** token 行，它与激活事务竞争时只有两种串行结果：(a) 旧 token 先消费成功并提交 → 事务 B 读到 `consumed_at >= candidate.created_at`，把 candidate 置 `cancelled` 而**不激活**，用户手里不会多出一条仍可消费的链接；(b) 事务 B 先提交 → 旧 token 已 `superseded`，其消费返回 invalid。

v7 在此处写的是「(a) 旧 token 先消费成功，随后 replacement 激活」，那会留下一个未消费的 active replacement，第二次消费即产生**第二个** session，与本段结论及测试 26i 的 `total session ≤ 1` 自相矛盾。v8 以事务 B 的投递期消费检查消除该分支（§5.3a F-P）。因此现在可以成立地声称：不存在两个 session，也不存在 pending token 被消费。代价是一次「用户在替换链接投递途中用掉了旧链接」会让该替换链接直接作废——用户已经登录成功，这正是期望行为。

**monotonic latest-candidate 与并发 intake**：同一邮箱通常因 pending fence 只有一个 candidate；激活复检仍是强制防御，覆盖人工重试、迁移异常、SMTP 阻塞与并发边界。事务 B 在已锁定该邮箱未终态 token 后，必须把 candidate 的 `(created_at, id)` 与**每个更新的 eligible replacement** 比较；eligible 集合为同邮箱 `delivery_state IN ('pending','active')` 且 `consumed_at IS NULL`、`superseded_at IS NULL`，不能只看 pending。若存在任一更大 tuple，当前旧 candidate 原子转为 `superseded`（不得改动较新的 pending/active 行），提交为 terminal success/no-op，不记录 `magic_link_sent`；其任务重试命中 terminal no-op。若当前 candidate 已因另一执行激活，则走 active-delivered 幂等恢复；若已 superseded/cancelled/consumed，则 terminal no-op。只有 eligible 集合中 tuple 最大者可激活并 supersede**比自己旧的** active token。特别地，旧任务在 SMTP 阻塞期间若较新 candidate 已激活，旧事务 B 必须 supersede 旧 candidate 自身而不能替换较新 active token。相同 `created_at` 严格以 `id` 决胜；锁定全体未终态 token使并发事务串行，不存在两个事务各自通过快照的窗口。

### 5.3b 晋升围栏：跨 SMTP 的可线性化投递预留（F-Q）

v6 只在事务 B 做「发信后再查角色」。这不满足不变量 3：事务 A 释放 user 行锁之后、SMTP 调用之前提交的晋升，会让协议**明知**地把 Magic Link 发进一个已经是 admin 的邮箱，而事务 B 至多能在**不可撤销的邮件已经发出之后**取消 candidate。取消 candidate 只消除「可用 session」，不消除已经发生的外部副作用。因此晋升与发送之间需要一个可线性化的预留/围栏，而不是事后角色检查。

**为什么不能靠跨 SMTP 持锁**：唯一「自然」的写法是把 email advisory lock 或 user 行锁一直持到事务 B。这会在一次网络 RTT（最坏 75 s，见下）内占住数据库连接与锁，正是 AGENTS.md 与 §5.7 禁止的形态，还会让同邮箱的消费与清理长时间排队。预留把这段互斥**下沉为一行持久状态**，从而不持任何锁。

**预留（写入方）**：事务 A 在同一事务内完成「锁定读到 non-admin」与「写 `candidate.delivery_reservation_until = now() + MAGIC_LINK_DELIVERY_RESERVATION_SECONDS`」，两者原子。事务 B 激活或取消时清空该列。SMTP 失败时**不**清空，让它自然到期——提前清空等于给晋升开一个本次投递仍可能在途的窗口。

**观察（晋升方，规范性）**：仓库中会使某个邮箱成为 admin 的写路径只有两条，二者都必须实施本围栏：

| 路径 | 位置 | 性质 |
|---|---|---|
| `setupSite()` | `src/modules/site/index.ts:246-253` | `onConflictDoUpdate` 把既有 user 升为 `role: "admin"` |
| `changeAdminEmail()` | `src/modules/auth/admin-account.ts:162-193` | 把 admin 的 `users.email` 改为另一个邮箱，使**该邮箱**成为 admin 邮箱 |

（`src/modules/user/index.ts`、`oauth.ts:399`、`supporter-wall/index.ts:274` 的 `update(users)` 都不写 `role`、不写 `email`，不在围栏范围内；实现不得顺手扩大范围。）

两条路径必须在**其既有事务内**、在写 `role`/`email` **之前**：

```text
1. pg_advisory_xact_lock(hashtext(normalizedTargetEmail))   ← 与 intake/投递同一把锁
2. SELECT magic_link_tokens WHERE email = $1 FOR UPDATE
3. 若存在 delivery_state = 'pending' AND delivery_reservation_until > now()
      → 整个晋升事务回滚，抛可重试错误（ApiError 409 "magicLinkDeliveryInFlight"）
        不得等待、不得跳过、不得改写该 candidate
4. 否则把该邮箱全部 pending candidate 置 cancelled（含清空预留），再执行既有 role/email 写入
```

`changeAdminEmail()` 的**新旧两个邮箱**都要走该流程：新邮箱因为即将成为 admin，旧邮箱因为不再是 admin（旧邮箱侧只需第 4 步的常规处理，不需要因预留而失败）。advisory lock 取得顺序固定为「按规范化邮箱字符串升序」，避免两个并发改名事务互等。

**为什么第 3 步是 fail closed 而不是等待**：等待会把一次运营操作阻塞在一个由外部 SMTP 服务器决定时长的窗口上，且必须在持有 user 行锁的情况下等待。直接失败并让运营者重试，把等待移到事务之外，最坏重试间隔就是预留上限。两条路径都是低频运营操作（`setupSite()` 一生一次且 `isInitialized()` 已守卫，改管理员邮箱是罕见操作），这一代价可接受。错误必须是明确可重试的文案，不能表现为 500。

**时限与跨字段校验**：`MAGIC_LINK_DELIVERY_RESERVATION_SECONDS` 默认 `120`，范围 30–600。它必须严格大于一次 `sendMagicLinkEmail()` 的最坏调用时长，否则预留会在邮件仍在途时到期。该最坏时长由 `getTransporter()` 的三个常量确定：`connectionTimeout: 15_000` + `greetingTimeout: 15_000` + `socketTimeout: 45_000` = **75 s**（`src/modules/mail/index.ts:42-44`）。因此 `assertRuntimeSecurity()` 增加一条 fail-closed 断言：

```text
MAGIC_LINK_DELIVERY_RESERVATION_SECONDS × 1000 ≥ SMTP_WORST_CASE_CALL_MS + 30_000
```

默认 `120_000 ≥ 75_000 + 30_000 = 105_000` ✅。`SMTP_WORST_CASE_CALL_MS = 75_000` 按仓库既有做法在 `src/lib/env.ts` 顶部**镜像**声明（与 `TASK_BATCH_SIZE`（`env.ts:8`）镜像 `tasks/index.ts:31` 完全同形），避免 `env.ts` 为了解析环境变量而 import `nodemailer`。镜像必须由一条漂移守卫测试固定：该测试同时 import `env.ts` 的常量与 `mail/index.ts` 导出的实际超时三元组，断言二者之和相等；改动任一侧而不改另一侧必须 RED。

预留上限也必须落在租约续期能力之内：`TASK_LEASE_MS = 60_000`，dispatcher 每 `TASK_LEASE_MS / 3` 续租（`dispatcher.ts:55-71`），因此一个仍在运行的 handler 可以覆盖 120 s 的预留窗口而不丢租约。这不改变 §5.4 的结论——那里说明的是不存在有限的**最坏重试** horizon，与单次执行内的续租能力是两件事。

**残余边界（必须如实写入 §11 与 PR 描述）**：

1. **崩溃窗口**：worker 在事务 A 提交后、事务 B 之前崩溃，预留会在最多 `MAGIC_LINK_DELIVERY_RESERVATION_SECONDS` 内阻塞晋升，之后自动放行。排序不变量仍成立：那次 SMTP（若已发生）线性化于预留到期之前，因而也在晋升提交之前；重试的事务 A 会读到 admin 并取消 candidate，0 第二次发送。
2. **超时被违反**：若 SMTP 传输层实际耗时超过 75 s（provider 忽略 socket 超时、或未来有人调大这三个常量而未同步预留下限），预留可能在调用仍在途时到期，晋升即可提交。此时事务 B 的预留到期检查会拒绝激活并取消 candidate，因此**不会**产生可用链接；但该次邮件确实可能在晋升之后才离开进程。这是本围栏唯一的排序漏洞，由上面的 fail-closed 不等式与漂移守卫测试收敛到「只有同时改坏两处才可能发生」。
3. **不覆盖数据库外的角色来源**：本围栏只约束 `users.role` / `users.email` 的数据库写入。若将来引入外部 IdP 或配置文件驱动的 admin 判定，必须重新评估本节。

### 5.4 intake 超龄界与重试时限（F184-01，v5 加固）

durable task 的退避是 `taskBackoffMs(attempts) = 60_000 × 2 ** (attempts − 1)`（`src/modules/tasks/index.ts:496-498`），`DEFAULT_MAX_ATTEMPTS = 5`（`src/modules/tasks/enqueue.ts:8`）。第 1–4 次失败依次推迟 60 + 120 + 240 + 480 = **900 s = 15 min**，因此**最后一次尝试必然在 `created_at + 15 min` 之后开始**。

若把超龄界设为 `MAGIC_LINK_TTL_MINUTES`（15 min），则任何经历过 4 次瞬时失败的 intake 在最后一次尝试时**必定**落入超龄分支，永远无法签发，而任务被标记为 `succeeded`（带 note），用户却已看到 `accepted`。这是一个不可达的死角。

**结论**：超龄界必须与 `MAGIC_LINK_TTL_MINUTES` 解耦，但不能靠一个声称覆盖「最坏重试时限」的固定分钟数来保护重试。基线 dispatcher 会每 `TASK_LEASE_MS / 3` 续租（`dispatcher.ts:55-71`）；一个仍在运行的 handler 可以持续续租，瞬时失败也可能发生在任意执行时长之后。因此不存在只由退避、poll interval 与**单个** lease 推导出的有限最坏 horizon。v4 的 `1_010_000 ms` 公式只计一次 lease wait，不能证明第 5 次执行仍位于超龄界内。

规范性修复是把超龄判定限定在**首次 claim**：

```text
if task.attempts === 1
   and request.created_at < now() - MAGIC_LINK_REQUEST_MAX_AGE_MINUTES
then resolved without mint + warn
```

`attempts` 在 claim 时递增（ADR 0003；`claimOneTaskForClassBranch`），因此：

- 队列中从未开始执行、直到超龄才首次被领取的 intake 会安全终止并告警；
- 只要首次执行在超龄界内开始，之后由瞬时失败、进程崩溃、lease 回收、长时间执行或退避产生的第 2–5 次 claim **一律不得再做 age rejection**，仍保留正常 mint 机会；
- `resolved_at` 幂等出口和双重 claim fence 继续阻止已提交请求重复 mint；
- 手工重试若把 `attempts` 重置为 0，下一次 claim 重新成为首次执行并重新应用 age policy；这是显式的运营动作，不伪装成原自动重试。

- 新增 `MAGIC_LINK_REQUEST_MAX_AGE_MINUTES`（int，**`1–1440`**，默认 **30**）。它只控制「尚未开始执行的陈旧请求是否还值得签发」，不再需要与退避常量做虚假的 horizon 跨字段校验。
- 超龄仍然可能发生（队列长期饱和、任务被反复抢占）。此时它是**可观测终态**：发出 §5.9 的告警，而不是静默的成功 no-op。
- 超龄分支对所有角色一致触发，因此不影响不可区分性（G1/G2 不受影响）。
- 用户侧语义：超龄界只约束「多久之前的请求还值得为它创建 pending candidate」；邮件中链接自身的 15 分钟 TTL 从 **SMTP 成功后的激活时刻**起算（§5.3a），因此不会因 intake/投递排队而「刚激活就过期」。

### 5.5 `magic_link_requests` 表

```sql
create table "magic_link_requests" (
  "id"              uuid primary key,
  "email"           text not null,
  "locale"          text,
  "redirect_path"   text,
  "ip"              text,
  "user_agent"      text,
  "created_at"      timestamptz not null default now(),
  "resolved_at"     timestamptz,
  "minted_at"       timestamptz,
  "minted_token_id" uuid references "magic_link_tokens"("id") on delete set null
);
create index "magic_link_requests_cleanup_idx"
  on "magic_link_requests" (greatest("created_at", coalesce("minted_at", "created_at")), "id")
  where "resolved_at" is not null;
create index "magic_link_requests_mint_budget_idx"
  on "magic_link_requests" ("email", "ip", "minted_at" desc)
  where "minted_at" is not null;
```

- `id` 由应用生成（`randomUUID()`），不使用 `defaultRandom()`，以固定 INSERT 形状并允许在 INSERT 前构造任务 payload。
- `email` 存规范化明文，与既有 `magic_link_tokens.email` / `login_codes.email` 敏感度一致；worker 必须拿到明文才能 mint 与投递，摘要不可逆，故不使用摘要列。
- `ip` / `user_agent` 与 `magic_link_tokens` 同列同语义。
- **无角色列、无原因列**：`resolved_at` 只表示「已处理」，`minted_at` 只表示「本次是否签发」。admin、dedupe、fence、预算耗尽、超龄五种不签发成因在表中**彼此不可区分**——这是防止未来有人加一列就重新引入持久角色标记的唯一结构性屏障，由 §10 切片 2 测试 8 逐列固定（F184-15）。
- 预算计数用 `minted_at`（而非 `minted_token_id`）作判据，使 `on delete set null` 不会放松预算。
- 清理索引是 `resolved_at is not null` 的部分表达式索引，并直接建在 `greatest(created_at, coalesce(minted_at, created_at))` 上，与 §5.7 的删除谓词一致（表达式索引，`greatest`/`coalesce` 对 `timestamptz` 是 immutable）。未解析行不进入清理索引，也不得被常规保留期清理删除。

### 5.5a `magic_link_tokens` delivery lifecycle

必须按下列顺序执行 migration（不得把它压缩为在 backfill 前验证约束的单条 `ALTER`）：

```sql
alter table magic_link_tokens
  add column delivery_state text,
  add column delivered_at timestamptz,
  add column superseded_at timestamptz,
  add column delivery_reservation_until timestamptz;   -- §5.3b 晋升围栏；始终 nullable

update magic_link_tokens
set delivery_state = 'active',
    delivered_at = /* succeeded task timestamp if provable, else token.created_at */;

alter table magic_link_tokens
  alter column delivery_state set default 'active',
  alter column delivery_state set not null,
  alter column delivered_at set default now(),
  add constraint magic_link_tokens_delivery_state_check
    check (delivery_state in ('pending', 'active', 'superseded', 'cancelled')),
  add constraint magic_link_tokens_delivery_timestamp_check
    check (
      (delivery_state = 'pending' and delivered_at is null)
      or (delivery_state = 'active' and delivered_at is not null)
      or delivery_state in ('superseded', 'cancelled')
    ),
  add constraint magic_link_tokens_delivery_reservation_check
    check (delivery_reservation_until is null or delivery_state = 'pending');

create index magic_link_tokens_email_delivery_state_idx
  on magic_link_tokens (email, delivery_state, created_at desc, id desc);
create index magic_link_tokens_pending_cleanup_idx
  on magic_link_tokens (created_at, id)
  where delivery_state = 'pending';
```

状态机只有：`pending → active | superseded | cancelled`、`active → superseded`；`superseded` / `cancelled` 为终态。既有 `consumed_at` 仍独立表示消费终态；消费成功的 active token 不回写 delivery state。禁止 `pending → consumed`。

`delivery_reservation_until` 只在 `pending` 期间可有值（由上面的 CHECK 强制），语义是「§5.3b 的晋升围栏窗口」，既不是 token 有效期，也不参与 verify/consume 的任何谓词。它由事务 A 写入，由事务 B 的激活或取消清空；离开 `pending` 的任何转换都必须同时把它置 `null`。既有行回填为 `null`——它们都不是 pending，也没有在途投递。它不需要独立索引：所有读取点（事务 A/B、§5.3b 晋升围栏、cleanup 复检）都已经按主键或 `email` 锁定了目标行。

迁移兼容规则：

1. `delivery_state` / `delivered_at` 的数据库默认值在整个兼容发布期必须分别是 `active` / `now()`，使尚未升级、未显式写新列的旧代码仍保持原验证语义；新 intake 代码必须显式写 `pending` / `null`。
2. migration 必须先加 nullable lifecycle 列并回填，再设置 defaults / `NOT NULL` / 两个 CHECK，避免约束在回填中间态失败。所有既有 token 回填为 `active`。若能由 succeeded delivery task 确定已投递，则回填 `delivered_at = coalesce(task.updated_at, token.created_at)`；其它既有 token 的 `delivered_at` 回填为 `token.created_at`。这是一次保守可用性选择：历史 schema 无法可靠区分「已投递」与「仅入队」，错误地设为 pending 会让升级瞬间烧毁用户手里的链接。
3. 回填不延长既有 `expires_at`，不复活已消费/已过期 token；新查询仍同时应用既有 consumed/expiry 谓词。
4. 在发布门删除旧同步分支的后续版本，才可把 `delivery_state` 默认值改为 `pending` 并移除 `delivered_at` 默认值；本 Issue 的 migration 不得提前这样做。
5. 不建「每邮箱唯一 active」的 partial unique index：历史数据与消费/激活滚动窗口可能已有多行，且 correctness 由同邮箱 advisory lock + `FOR UPDATE` + pending/active monotonic-candidate 复检保证。索引仅服务查询，不代替事务约束。

token 清理必须增加 delivery-aware 谓词：可删除自然过期/已消费/`superseded`/`cancelled` token；`pending` 仅在对应 **protocol v2** delivery task 已是 `succeeded`（幂等残留）或 `dead`，且 `task.updated_at < now() - MAGIC_LINK_REQUEST_RETENTION_HOURS` 后删除。task schema 没有 `cancelled` 状态，本 Issue 也不新增；这里的 `cancelled` 只属于 token delivery lifecycle。这里明确复用现有 request retention 作为 terminal-task 调查窗口，不新增另一个模糊期限。不得把 legacy task/token 当作 pending protocol，也不得删除仍被 `pending` / `processing` / **仍可 claim/retry 的 `failed`** 任务引用的 candidate。

**终态提交后的显式入口（规范性）**：`deliverMagicLinkEmailTask()` 抛 permanent/final 错误时 task 仍是 `processing`，所以 `magic-link.ts` handler **不得**声称自己能观察或清理该终态。task 子系统必须拥有一个 post-finalization hook：`markTaskDead()`、`markTaskFailed()` 的 failed-to-dead 分支，以及 `sweepExpiredFinalAttemptTasks()` 各自在 task 终态事务**成功提交之后**，把已提交的 task ID 交给 `reconcileTerminalMagicLinkCandidates({ taskIds })`。hook 只处理显式 protocol v2 `auth.magic_link_email`；其它 kind / legacy payload 立即 no-op。hook 不得在 task 状态事务、handler 激活事务或 email advisory-lock 临界区内运行。

**最终一致性重试**：post-finalization hook 是低延迟触发器，不是唯一触发器。dispatcher 每轮 final-attempt sweep 之后必须调用同一个有界 reconciler（无指定 IDs 时按 `tasks.updated_at, tasks.id` 扫描 terminal `auth.magic_link_email`；锁定后解密/校验 payload 才确认 protocol v2），从而覆盖进程在 task 终态提交与 hook 之间崩溃、hook/reconciler 自身数据库失败、以及旧版本先提交的终态。每批上限固定为 200 并使用 `FOR UPDATE SKIP LOCKED`；未到上述 retention cutoff 的 task 本轮 no-op、以后仍可选。一次失败只记录不含敏感 payload 的 `{ taskId? }` 与错误分类，不改变已提交 task 状态、不重新发送、不阻塞其它 task，下一 dispatcher tick 必须再次可选。不能以进程内 “already attempted” 集合永久跳过失败项；删除成功或 candidate 已非 pending 才是该项的幂等收敛。

**事务、锁与引用安全**：每项 cleanup 独立短事务，固定 `task row FOR UPDATE → token row FOR UPDATE`；锁定 task 后重新验证 kind、protocol、tokenId 对应、terminal status 与保留期，再锁 token 并重新验证仍为 pending，最后删除。与 handler 的 task-claim → advisory → token 同向，禁止 token → task 反序；reconciler 不取得 email advisory lock，也不调用 SMTP/事件/对象存储。任何 `pending` / `processing` / 可重试 `failed` task（包括刚被人工 `retryTask()` 恢复者）在 cleanup 锁定后的复检都不可选；cleanup 与 retry/claim/activation 竞争时由 task 行锁先线性化，绝不留下 live/retryable task 指向已删 token。terminal task 与 pending candidate 不匹配时告警并保守 no-op。该职责分工是：`magic-link.ts` 导出候选引用验证/删除原语，`tasks/index.ts` 拥有所有终态转换后的 hook 与周期 reconciler 调度，`dispatcher.ts` 在 final-attempt sweep 后调用调度入口。

### 5.6 mint 预算：持久、精确、不可跨来源锁死

worker 第 8.e 步，仅当 `request.ip` 非空时执行：

```sql
select count(*)::int as minted
from magic_link_requests
where email = $1
  and ip = $2
  and minted_at is not null
  and minted_at > now() - ($windowMs * interval '1 millisecond');
```

- 上限：`MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX`；窗口：`REQUEST_CODE_RATE_WINDOW_MS`。
- 该查询在**持有该邮箱 advisory lock 的事务内**执行，因此计数与随后的 mint 是原子的：**不存在超发，也不存在保守多计**。
- key 同时绑定 `email` 与**请求者自己的可信 IP**：来源 A 无法耗尽受害者在来源 B 的签发能力（S4 §0 #2/#3 同一原则）。
- **不与 `request-code-email-ip:*` 共享**：共享会重建 §1.3 的跨流程 oracle。
- `request.ip` 为空（默认 unresolved 部署）时**跳过**该计数预算；此时目标相关约束退化为 §8.1 的 delivery-aware spacing/pending fence。它不能提前废除既有 delivered active token，但在旧 token 自然过期后不保证持续可用；不得再称为「不可用于拒绝服务」。这不是跳过 route-level 保护：来源桶仍生效，而纯 email 计数预算会产生 §8.1 所示更直接的跨来源锁死。

**F2 的正面回答**：v3 的全部不可区分性保证（G1–G6、G8）都**不依赖**身份解析——公开路径根本不查询目标状态。身份解析只影响「是否额外启用按计数的反垃圾邮件上限」。

**F3 的正面回答**：v3 **没有** attempt 预算，也不存在「收敛点」概念——从第一次请求起就没有差异。公开路径唯一的预算是既有来源桶，其默认值语义不变。

### 5.7 保留期与清理（在主事务之外）

**位置（F184-06，规范性）**：清理**不得**放进 §5.3 的主事务。AGENTS.md「Engineering requirements」禁止把无关数据库操作放进事务或 advisory-lock 临界区，而清理删除的是与本邮箱**完全无关**的行，却会在持有 `pg_advisory_xact_lock(hashtext(email))`（`deliverMagicLinkEmailTask` 也取同一把锁，`magic-link.ts:332`）与 `magic_link_tokens` / `users` 行锁的情况下与其它 worker 争抢同一批「最旧 200 行」。后果有二：(a) 无关邮箱的投递被阻塞；(b) 两个并发删除以不同顺序取行锁会产生 `40P01` 死锁，回滚一次**本已成功的 mint** 并消耗一次重试配额（与 §5.4 的重试时限相互放大）。

因此：主事务提交后，以**独立事务**执行，异常只记日志、不影响已提交的 mint，也不使任务失败：

```sql
delete from magic_link_requests
where id in (
  select id
  from magic_link_requests
  where resolved_at is not null
    and greatest(created_at, coalesce(minted_at, created_at))
        < now() - ($retentionHours * interval '1 hour')
  order by greatest(created_at, coalesce(minted_at, created_at)), id
  limit 200
  for update skip locked
);
```

- **只删除已解析行**：`resolved_at is not null` 是强制谓词。`pending` / `processing` / 可重试 `failed` 的 intake 仍需要这行作为 durable payload state；即使它早于保留期也不得删除。否则任务会把 `request row missing` 当成成功 no-op，或与已读行但尚未写回 `resolved_at` / `minted_at` 的 handler 竞态，造成用户无超龄告警地收不到链接，甚至让已 mint 结果退出持久预算计数。
- `for update skip locked` + 确定性排序键 `(greatest(...), id)` 消除并发删除之间的死锁与互等。因为 worker 直到主事务提交才把行变为 resolved，清理无法选中正在处理的未解析行；已解析但任务尚未标记成功的行可安全删除，后续重试按既有 `request row missing` 幂等 no-op 退出，因为业务结果已经提交。
- 删除谓词用 `greatest(created_at, coalesce(minted_at, created_at))` 而不是 `created_at`（F184-05）：预算按 `minted_at` 计数，而 `minted_at` 可能比 `created_at` 晚至多 `MAGIC_LINK_REQUEST_MAX_AGE_MINUTES`；只按 `created_at` 删除会在行仍应计入预算时把它删掉，静默放松 §5.6 的上限。
- 每次任务最多删 200 行；正常完成（包括 admin / dedupe / fence / budget / over-age 抑制）的请求都会置 `resolved_at`，因此稳态下已解析行的删除速率不低于正常完成写入速率。**dead-letter 后仍未解析的行不由常规清理删除**：它们必须与 dead intake task 一起保留，供告警调查或明确的人工重试/处置，避免静默丢失 durable state；运营监控必须同时覆盖 `resolved_at is null` 的陈旧行数。不得为了表容量收敛而删除仍被非终态或 dead task 引用的行。

**保留期跨字段校验（fail closed，位于 `assertRuntimeSecurity()`）**：

```text
MAGIC_LINK_REQUEST_RETENTION_HOURS × 3_600_000
  ≥ REQUEST_CODE_RATE_WINDOW_MS + MAGIC_LINK_REQUEST_MAX_AGE_MINUTES × 60_000
```

默认值：`24 h = 86 400 000 ≥ 3 600 000 + 1 800 000 = 5 400 000` ✅。这修正了 v2 只比较窗口、忽略 `minted_at` 滞后的偏差（F184-05）。

### 5.8 环境变量、跨字段校验与升级兼容

| 变量 | zod 声明 | 默认 / 未设置时 | 语义 |
|---|---|---|---|
| `MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX` | `z.coerce.number().int().min(1).max(10_000).optional()` | **未设置 ⇒ 由助手回落到 `REQUEST_CODE_EMAIL_IP_RATE_MAX` 的生效值**（见下） | 每 (邮箱, 可信 IP) 每窗口的 Magic Link 签发上限 |
| `MAGIC_LINK_REQUEST_MAX_AGE_MINUTES` | `z.coerce.number().int().min(1).max(1440).default(30)` | `30` | 首次执行的 intake 超龄界（§5.4）；自动重试不再应用该判定 |
| `MAGIC_LINK_REQUEST_RETENTION_HOURS` | `z.coerce.number().int().min(1).max(720).default(24)` | `24` | `magic_link_requests` 保留期（§5.7） |
| `TASK_AUTH_INTAKE_MAX_PER_BATCH` | `z.coerce.number().finite().int().min(0).max(20).default(4)` | `4` | `auth_intake` 队列每批上限（§5.3），与既有 `TASK_MAINTENANCE_MAX_PER_BATCH`（`env.ts:59`）同形状；`0` 仅在发布门关闭时合法，见下 |
| `MAGIC_LINK_DELIVERY_RESERVATION_SECONDS` | `z.coerce.number().int().min(30).max(600).default(120)` | `120` | §5.3b 投递预留窗口；必须覆盖一次 SMTP 调用最坏时长 |
| `MAGIC_LINK_INTAKE_ENABLED` | `z.string().default("false").transform((v) => v === "true")` | `false`（引入该特性的版本） | 发布门（§9.2）。`false` 时公开路径沿用基线同步路径；`true` 时启用 v3 intake 路径 |

**布尔解析约定（F-M，规范性）**：`MAGIC_LINK_INTAKE_ENABLED` **必须**沿用仓库中每一个布尔变量的既有形状 `z.string().default("false").transform((v) => v === "true")`（例：`SECURITY_HSTS_ENABLED`，`src/lib/env.ts:16-19`）。这意味着**只有精确的字符串 `"true"` 才为真**；`"1"`、`"TRUE"`、`"yes"`、`"on"` 全部解析为 `false`。鉴于这是决定 #184 在某个部署里到底修没修的开关（§11.7），该约定必须写进 `.env.example` 注释，并由 §10 测试 32 对 `"1"` 与 `"TRUE"` 显式断言为 `false`，避免运营者「以为打开了其实没打开」。

**F9 的正面回答**：`MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX` 未设置时**动态回落到运营者当前生效的 `REQUEST_CODE_EMAIL_IP_RATE_MAX`**（不是硬编码 5）。把上限调低到 2 以抑制 Magic Link 的运营者，升级后仍得到 2。

**实现位置（规范性，F184-12 + F-E）**——分两处，不要混：

1. **断言与告警 → `assertRuntimeSecurity(env)`**（`src/lib/env.ts:227-236`，由 `getEnv()` 在 `:342` 调用），与该函数已有的 `TASK_*_PER_BATCH ≤ TASK_BATCH_SIZE` 检查同一风格，抛普通 `Error`。**不要**改用 zod `superRefine`——那会引入仓库未使用的第二套跨字段校验模式并改变错误文案（zod 路径抛 `环境变量配置错误: …`）。四项：
   - **fail closed**：保留期不等式（§5.7）。该式引用 `MAGIC_LINK_REQUEST_MAX_AGE_MINUTES`，两者都是已解析值，可直接比较；
   - **fail closed**：intake 门与 intake cap 的一致性（F-R）——`MAGIC_LINK_INTAKE_ENABLED === true ∧ TASK_AUTH_INTAKE_MAX_PER_BATCH < 1` 必须抛错。理由：这两个值单独看都合法，组合起来却构成一个「公开端点照常受理每一个请求，但 dispatcher 被禁止领取任何 intake 任务」的部署。此时全部 intake 永久停在 `pending`，用户永远收不到链接，而 §5.4 的首次执行超龄判定与 §5.10 的 dead-letter 告警**都不会触发**（它们都要求任务至少被 claim 一次），运营者因此连降级都观察不到。保留 `.min(0)` 的 zod 形状与 `TASK_MAINTENANCE_MAX_PER_BATCH` 一致（`0` 在门关闭时是合法的「彻底不处理」配置），只在门打开时把它升级为错误，是唯一既不破坏形状一致性又能 fail closed 的位置；
   - **fail closed**：§5.3b 的预留窗口不等式 `MAGIC_LINK_DELIVERY_RESERVATION_SECONDS × 1000 ≥ SMTP_WORST_CASE_CALL_MS + 30_000`；
   - **仅告警**：`REQUEST_CODE_SEND_DEDUPE_SECONDS × 1000 > MAGIC_LINK_TTL_MINUTES × 60 000` 时输出启动告警（成功激活后的 spacing 配置风险，§4.1 / §8.1；不是永续可用性证明）。
2. **回落（值推导）→ `src/modules/auth/rate-limit-policy.ts` 的新导出助手**，例如：

   ```ts
   export function getMagicLinkMintEmailIpMax(env: Env): number {
     return env.MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX ?? env.REQUEST_CODE_EMAIL_IP_RATE_MAX;
   }
   ```

   **回落不能放进 `assertRuntimeSecurity()`**（F-E）：该函数接收已解析的 `Env`、返回 `void`，`getEnv()` 丢弃其返回值；在其中改写 `parsed.data` 属于在一个名字与每个既有分支都表明「断言或抛错」的函数里做值推导。而 `rate-limit-policy.ts` 已经承担了完全相同形状的「env → 生效上限」推导（`getRequestCodeEmailIpRateLimit` 等，`:89-99`），是自然归属。worker 的 §5.6 预算判定调用该助手，而不是直接读 env。

   注意：这使 `src/modules/auth/rate-limit-policy.ts` 进入 §12 变更清单——它此前被列为「不修改」，本条取代那一处。该文件仍**不新增任何 limiter key**，只新增一个纯函数。

窗口沿用 `REQUEST_CODE_RATE_WINDOW_MS`，不新增窗口变量。

### 5.9 摘要用途消歧

仓库中有两个**不同**的邮箱摘要，取值不同，**不得混用或互相断言相等**：

| 用途 | 构造 | 出现位置 |
|---|---|---|
| 日志 / `app_events` payload | `hmacSha256WithPurpose("auth-log-email", normalizedEmail)` | `magic-link.ts:196, 210, 281, 290`；本规格所有 `emailDigest` 字段 |
| 内存 limiter key | `authEmailRateLimitDigest()` = `hmacSha256WithPurpose("auth-rate-limit-email", …)` | `rate-limit-policy.ts:24-26`（key 形状见 `:95`），仅 `request-code` / `verify-code` 流程使用 |

v3 的 Magic Link 路径**只使用前者**，且**完全不构造任何新的 limiter key**。规格与实现中出现的 `emailDigest` 一律指 `auth-log-email` 摘要。

### 5.10 可观测性与 payload 白名单

- **`magic_link_requested`**：在**公开请求提交后**记录，payload 白名单严格为 `{ requestId, emailDigest }`。基线的 `{ tokenId, keyId, emailDigest }` 只在真正 mint 时出现，是持久的角色相关标记；移到 intake 后它对每个请求都出现，不含角色信息。**不得**为了控制体量而只对已签发的 intake 记录该事件——那会重新引入角色相关事件（见 §11.2 对增长的处理）。
- **intake worker 不记录任何区分「已签发 / 未签发」的事件**：那与角色相关，禁止新增。
- **不新增 `AppEventType`**。
- **intake 超龄告警（新增，F184-01）**：`logger.warn("Magic Link 受理请求超龄未签发", { requestId, ageMs })`。**不含** `emailDigest`——超龄是队列健康信号，不需要按邮箱定位，少一个字段就少一处关联面。超龄对所有角色一致触发，因此该告警不泄露角色。
- **intake 任务 dead-letter 告警（新增，F184-03）**：`markTaskDead()`（`src/modules/tasks/index.ts:594`）与 `sweepExpiredFinalAttemptTasks()` 目前只经 `warnMailTaskDeadLettered()` 告警，而后者对 `isMailTaskKind()`（`src/modules/tasks/index.ts:53-55`，仅 `email` / `auth.login_code_email` / `auth.magic_link_email`）之外的种类**直接返回**。实现必须把 `auth.magic_link_request` 纳入 dead-letter 告警面（扩展该判定或新增一条同级 `logger.warn`），否则 §11.4 的「用户看到 accepted 却永远收不到链接」将**没有任何自动检测**。这把 `src/modules/tasks/index.ts` 纳入 §12 文件范围。
- **日志**：公开路径不记录任何抑制/角色相关日志（它不知道结果）。worker 只保留既有数据不一致告警 `logger.warn("活跃 Magic Link 缺少持久投递任务；保守抑制重发", { emailDigest, tokenId })`；**禁止**记录区分 admin / dedupe / 预算的原因字段。
- **`magic_link_sent`**：只在 §5.3a 激活事务提交后 best-effort 记录。SMTP 成功但激活未提交、stale lease、admin recheck、非 monotonic-latest candidate 均不得记录；active-delivered 恢复分支不得重发。既有 `app_events` 不能与 token 激活原子提交，故 crash window 可造成事件缺失；本 Issue 不用遥测伪造 delivery correctness。它仍在服务端遥测中隐含「该邮箱不是 admin」，不在威胁模型内（§3），记入 §11.5。
- 消费期 `magic_link_rejected` 的 `{ reason, boundary, tokenId, keyId, userId }` 白名单（#176 §4.4）不变。
- **禁止**在任何日志/事件/响应中出现：原始 token、token hash、明文邮箱、redirectPath、IP、user-agent、角色、limiter key 或桶状态。

### 5.11 失败语义

| 情形 | 行为 |
|---|---|
| keyring / SMTP 未配置 | 与基线相同抛 500；两者与目标无关，对所有角色一致 |
| 公开事务失败 | 整体回滚：无 intake 行、无任务；路由返回既有 500；与角色无关 |
| intake 任务事务失败 | 整体回滚，`resolved_at` 未设置，按 `taskBackoffMs` 退避重试（最多 5 次） |
| 连续 4 次瞬时失败后的第 5 次 | 首次 claim 已在 age policy 内，此后 `attempts > 1` 不再做超龄拒绝，故**仍有正常 mint 机会**（切片 4 测试 20 固定该性质） |
| intake 任务耗尽重试 | 由 dispatcher 标记 `failed` → `dead`，并触发 §5.10 新增的 dead-letter 告警 |
| intake 首次执行时已超龄（队列长期饱和） | 标记 resolved、不 mint，并发出 §5.10 的超龄告警；任务本身成功 |
| worker 崩溃（提交前） | 回滚 + 租约到期 + 重试 |
| worker 崩溃（提交后、标记任务成功前） | 重试时第 2 步读到 `resolved_at` 非空 → 成功 no-op；**不会重复 mint** |
| 陈旧 claim / 租约被抢占 | 第 1 步或第 4 步返回成功 no-op，不 mint |
| intake 引用的 request 行缺失 | 视为 durable-state 不变量破坏：记录只含 `requestId` 的告警并成功 no-op；正常保留期清理不得制造该状态（§5.7） |
| 未升级实例领到 intake 任务 | `runTaskHandler` 默认分支抛 `PermanentTaskError("Unsupported task kind")`（`tasks/handlers.ts:409-411`），`dispatchClaimedTask` 在**首次**尝试即 `markTaskDead`（`tasks/dispatcher.ts:83-86`）。这就是 §9.2 必须用发布门避免的场景 |
| request-row 清理事务失败 | 只记日志；不回滚已提交的 mint，不使任务失败（§5.7） |
| `recordEvent()` 失败 | best-effort，只记日志，不回滚（ADR 0002 / #175） |
| SMTP 瞬时失败 | candidate 保持 pending；旧 active token 不变；task 进入可重试 `failed`，终态 reconciler 不得删除 candidate |
| SMTP 永久失败 / final attempt 耗尽 | handler 返回后 dispatcher 先提交 task `dead`；提交后 hook 清理合格的过期 pending candidate。hook 失败不回滚 `dead`，周期 reconciler 最终重试；旧 active token始终不变 |
| SMTP 成功、激活前崩溃 | 重试可能重复发送同一 token；激活前旧 active token保持可用 |
| SMTP 成功后 claim stale | 激活事务 fence 失败并 no-op；新 claimant 重发同一 candidate 后才可激活 |
| 激活事务失败 | 整体回滚；candidate 仍 pending，旧 active token 仍 active，任务重试 |
| 激活提交后、任务 succeeded 前崩溃 | 重试识别已 active candidate，幂等完成；不重发、不重复事件 |
| 用户在 SMTP 期间晋升 admin | 事务 A 前晋升则 0 SMTP；事务 A 提交后至事务 B 之间由 §5.3b 投递预留互斥，晋升事务 fail closed 回滚、不可提交；仅当 worker 崩溃使预留自然到期时晋升才可插入，此时事务 B 的预留到期检查拒绝激活并 `cancelled`，0 active replacement、0 session；此前 active token 仍由消费期 admin guard 拒绝 |
| 晋升事务命中未到期投递预留 | `setupSite()` / `changeAdminEmail()` 整体回滚，抛可重试 `ApiError(409, "magicLinkDeliveryInFlight")`；`role`/`email` 不变，candidate 不被改写；最长重试等待为 `MAGIC_LINK_DELIVERY_RESERVATION_SECONDS`（§5.3b / §11.11） |
| 投递期间旧 token 被消费 | 事务 B 读到同邮箱 `consumed_at >= candidate.created_at` → candidate `cancelled`，不激活、不记 `magic_link_sent`，任务 `succeeded`；总 session 恒 ≤1（§5.3a F-P） |
| 事务 B 复检通过后租约被抢占 | 不可能：事务 B 以 `FOR UPDATE` 持 task 行到提交，重新 claim 与 final-attempt sweep 均 `SKIP LOCKED` 跳过，`markTaskFailed`/`markTaskDead` 等待该锁（§5.3 F-O） |
| 投递预留在 SMTP 仍在途时到期 | 事务 B 拒绝激活并把 candidate `cancelled`，任务 `succeeded`；邮件可能已发出但链接永不可用。由 §5.8 的 `≥ SMTP_WORST_CASE_CALL_MS + 30 s` fail-closed 断言与漂移守卫测试收敛（§5.3b 残余 2） |
| 受理时 admin、worker mint 前降级 | 公开路径没有角色快照；mint 边界读到 non-admin 后按正常 member/unknown 路径处理。此项明确 supersede #176 的 request-time 措辞 |
| 任一边界读到 admin 后再降级 | 已 resolved request / cancelled candidate 保持终态，不复活、不自动 mint/SMTP；新请求才可按当前角色重新授权 |
| post-finalization cleanup 失败或进程在 hook 前崩溃 | task 终态保持；周期 reconciler 下次 tick 重新选择，直到删除或发现 candidate 已非 pending。live/retryable 引用永不删除 |

### 5.12 被否决的替代方案

| 方案 | 否决理由 |
|---|---|
| v1 的三层内存预算 | F1/F5：admin 只读事务 vs member 写事务，latency class 无法相等；F2 默认失效；F3 收敛点不可达；F4 多 IP 采样不受限 |
| 把角色分支移到 `tasks` fence 之后（第一轮 F5 的 "cheap fix"） | 只消除 L2 内部差异，**不**消除只读事务 vs 写事务差异，仍不满足不变量 1 |
| 人工延迟填充 / 常量时间响应 | 负载与排队噪声下不可靠，长时间占用连接引入新 DoS 面，无法覆盖 WAL 刷盘差异（NG4） |
| 为 admin 写「影子 token / 影子投递任务」 | 违反不变量 2 |
| 给 admin 发信 | 违反不变量 3 |
| 在公开路径查询角色或持久化 request-time admin suppression bit | 重新引入 target-state 读取、role-dependent durable decision 与 latency class 差异，直接违反不变量 1；#176 的同步时间措辞已由 §2.3 supersede |
| intake 任务直接发信，不再经 `auth.magic_link_email` | 破坏既有投递 fence / supersede / 重试分类，违反不变量 4 |
| mint 时立即 supersede 旧 active token | queue insertion 不是 delivery；SMTP 失败或激活前崩溃会留下 0 条已投递可用链接，违反不变量 3 |
| SMTP 前先把 replacement 标成 active | verify/consume 可在邮件送达前接受攻击者触发的 replacement，并提前烧毁旧链接；仍有同一缺陷 |
| SMTP 成功后无 task fence 直接激活 | stale lease 可在新 claimant/新 candidate 之后回写并 supersede 更新链接，破坏重试 fencing |
| 用“发送标记”宣称 exactly-once SMTP | 数据库无法与 SMTP 原子提交；崩溃歧义不可消除。采用同 candidate 重发 + 幂等激活，并明确允许重复邮件 |
| 让签发继续消费共享 `request-code-email-ip:*` | 重建 §1.3 跨流程 oracle |
| 把 `/api/auth/request-code` 的 email+IP 429 也改成 accepted-shaped | 扩到第二条流程，改变 S4 已验收行为；超出 #184 范围 |
| unresolved 下改用**纯 email** 的按窗口计数预算 | 违反 S4 §0 #2/#8，并按 §8.1 反例构造出廉价定向拒绝 |
| 把 intake 塞进既有 `default` 类 | `default` 已承载支付回调、定时发布与订阅 reconcile；`run_after` 优先的 FIFO 排序会让未认证 intake 洪泛阻塞这些业务。第三轮复核 F-B 后明确拒绝，改用 §5.3 的专用 `auth_intake` 类与每批上限 |
| 清理放在 mint 主事务内（v2 方案） | 违反 AGENTS.md 的临界区规则，并制造死锁 / 无关阻塞（§5.7，F184-06） |
| 只为已签发的 intake 记 `magic_link_requested` 以抑制 `app_events` 增长 | 重新引入角色相关事件，自毁 §5.10 的理由（F184-07） |
| 每次重试都按 `created_at` 应用固定超龄界 | dispatcher 没有有限的 handler 执行时长上界，任何固定分钟数都可能吞掉合法自动重试；§5.4 改为只在首次 claim 判定（F184-01） |

---

## 6. 攻击者观察矩阵

约定：`A` = admin 邮箱，`M` = 已存在 member/fan，`U` = 不存在的邮箱。所有非 429 响应均为 `200 {"ok":true,"data":{"accepted":true}}`，响应头集合相同。「限流状态」指**请求者可观察**的限流状态。全部行均假定 `MAGIC_LINK_INTAKE_ENABLED=true`。

### 6.1 请求者可观察面

| # | 场景 | 角色 | 状态 | 响应体 | 响应头 | latency class | 事务内 / 总往返 | 按邮箱锁 | 请求者可观察限流状态 | 可区分？ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 首次请求 | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 来源桶 +1 | **否** |
| 2 | dedupe 窗口内重复请求 | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 来源桶 +1 | **否** |
| 3 | 投递任务 pending/processing/failed 期间重复请求 | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 来源桶 +1 | **否** |
| 4 | 重试 / 长时间重复采样（同一 IP，直到来源桶耗尽） | A / M / U | 200×N | 同一 | 同一 | **L1**×N | 4 / 6 | 无 | 来源桶 +N | **否** |
| 5 | **多 IP 采样**（任意多个来源、任意总次数） | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 各来源桶各自 +1 | **否**（G8） |
| 6 | **默认 unresolved 部署**（`TRUSTED_PROXY_HOPS=0`） | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | `request-code-unresolved` +1 | **否**（G7） |
| 7 | 同邮箱两个并发请求 | A / M / U | 两个 200 | 同一 | 同一 | 两个 **L1**，互不阻塞 | 各 4 / 6 | 无 | 来源桶 +2 | **否** |
| 8 | 不同邮箱高并发混合 | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 各自来源桶 | **否** |
| 9 | worker 崩溃 / intake 任务重试期间继续请求 | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 来源桶 +1 | **否**（worker 状态不在公开路径上） |
| 10 | intake 任务 dead / 超龄后继续请求 | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 来源桶 +1 | **否**（两者均与角色无关） |
| 11 | 队列饱和、intake 普遍超龄 | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 来源桶 +1 | **否**——超龄对所有角色一致，见 §8.3 |
| 12 | 来源门禁耗尽 | A / M / U | **429 `requestRateLimited`** | 同一错误体 | 同一 | **L0** | 0 | 无 | 来源桶已满 | **否**——只取决于攻击者自己的 IP |
| 13 | 跨流程探测：任意次 Magic Link 请求后立即 `POST /api/auth/request-code` | A / M / U | 该端点行为只取决于它自己的请求次数 | — | — | — | — | — | `request-code-email-ip:*` **从不被 Magic Link 推进** | **否**（G4） |
| 14 | mint 预算耗尽后继续请求（仅 resolved 身份可达） | A / M / U | 200 | 同一 | 同一 | **L1** | 4 / 6 | 无 | 来源桶 +1 | **否**（预算在 worker 内，无请求者出口） |

**结论**：不存在任何一行使 `A` 与 `M`/`U` 的请求者可观察量不同；`M` 与 `U` 在所有行完全一致（G6）。唯一的行为分叉（第 12 行 `L0`）由攻击者自身来源身份决定，与目标无关。

### 6.2 服务端副作用（**非**请求者可观察，用于证明 G5/G6 与不变量 2）

| 场景 | 角色 | `magic_link_requests` | intake 任务 | `magic_link_tokens` | **投递任务** `auth.magic_link_email` | 邮件 | 用户行 |
|---|---|---|---|---|---|---|---|
| 首次请求 | A | +1 行（`resolved_at` 置位，`minted_at` 空） | +1 | **0** | **0** | **无** | **零变更** |
| 首次请求，SMTP 前 | M / U | +1 行（`minted_at` 置位） | +1 | +1 `pending` | +1 | 0 | 零变更 |
| SMTP 成功并激活 | M / U | 不变 | 不变 | replacement `active`；旧 active → `superseded` | succeeded | ≥1 封（崩溃重试可重复同 token） | 零变更（用户在消费期才创建/更新） |
| SMTP 失败 / 激活前崩溃 | M / U | 不变 | 不变 | replacement 保持 `pending`；旧 active 不变 | retry/dead | 0 或邮件已被 SMTP 接受但状态未知 | 零变更 |
| dedupe / fence / 预算 / 超龄抑制 | A / M / U | +1 行（`minted_at` 空） | +1 | 不变 | 不变 | 无 | 零变更 |
| worker 重试（已 resolved） | A / M / U | 不变 | 成功 no-op | 不变 | 不变 | 无 | 零变更 |
| 同邮箱并发两请求 | M / U | +2 行 | +2 | **恰好 +1 pending candidate** | **恰好 +1** | 激活前 0；成功后 ≥1 封同 token | 零变更 |
| 同邮箱并发两请求 | A | +2 行 | +2 | **0** | **0** | **无** | **零变更** |

表内 `minted_at` 为空的五种成因（admin / dedupe / fence / 预算 / 超龄）在数据库中彼此不可区分（§5.5），由切片 2 测试 8 逐列固定。

`delivery_reservation_until`（§5.3b）不在表中单列，因为它与 `magic_link_tokens` 行同生共死、且只在 `pending` 期间有值：事务 A 在「+1 `pending`」那一行同时写入它，激活或取消时清空，SMTP 失败时保持到自然到期。它对请求者同样不可观察，且只在已经 mint 的分支存在——admin 分支根本没有 token 行，因此它不引入任何新的角色相关副作用。

---

## 7. 竞态与并发语义

| 场景 | 要求行为 |
|---|---|
| 公开路径并发（同邮箱） | 无共享锁、无唯一约束冲突，两请求互不阻塞，各自恒定 4 次事务内往返 |
| 两个 worker 同时处理同邮箱的两个 intake | advisory lock 串行；先者 mint pending candidate，后者在第 8.b 步命中 pending fence → 不 mint。**恰好一个 pending token、一个投递任务**；旧 active token 不变 |
| 激活事务与 `consumeMagicLinkToken()` 并发 | consume 不取邮箱 advisory lock；事务 B **无状态过滤地**锁定该邮箱全部 token 行，两者由共同的 token 行锁串行。旧 token 先消费提交 → 事务 B 读到 `consumed_at >= candidate.created_at`，candidate `cancelled`、**不激活**；事务 B 先提交 → 旧 token 已 superseded，消费返回 invalid。pending candidate 永不消费；两种串行结果都恰好 ≤1 个 session |
| 晋升事务与在途 SMTP 并发 | §5.3b：事务 A 在同一事务内锁定读到 non-admin 并写下未到期预留；晋升路径必须先取同一 advisory lock 并观察预留，命中即 fail closed 回滚。晋升只能线性化在事务 A 之前或事务 B 之后，不存在「已是 admin 却仍发信」的交错 |
| 晋升事务与 pending candidate（无在途投递） | 预留为空或已过期：晋升事务在同一事务内把该邮箱全部 pending candidate 置 `cancelled` 并清空预留，再写 `role`/`email`；不产生孤立 pending token |
| 两个并发晋升事务（改管理员邮箱） | 按规范化邮箱字符串升序取 advisory lock，新旧邮箱各一把，无反向等待 |
| 事务 B 与租约抢占 / final-attempt sweep 并发 | 事务 B 以 `FOR UPDATE` 持有 task 行直到提交：重新 claim 与 sweep 均为 `FOR UPDATE SKIP LOCKED` → 跳过；`markTaskFailed`/`markTaskDead` 取同一行锁 → 等待。不存在「复检通过后、激活写入前被抢占」的窗口，也不会出现 active token 对应 dead task |
| 清理与未解析 intake 行并发 | 清理谓词已限定 `resolved_at is not null` 且 `for update skip locked`；handler 第 2 步另以 `FOR UPDATE` 锁定该 intake 行直到提交，因此即使未来清理谓词被放宽，也不能在 handler 等待 advisory lock 期间删除它 |
| worker 与 `deliverMagicLinkEmailTask()` 并发 | 两者都取同一把按邮箱 advisory lock，串行执行；因清理已移出主事务（§5.7），worker 不会在持锁期间做无关删除而阻塞投递 |
| intake 读到 member、SMTP 前后用户被提升 | 事务 A 前晋升：cancelled、0 SMTP；事务 A 提交后至事务 B 之间：由 §5.3b 预留排除，晋升无法提交；B 锁定 non-admin 并先提交：可激活，随后提升由 #176 消费守卫拒绝 session。仅当 worker 崩溃且预留自然到期时，晋升才可能落在两者之间，此时事务 B 的预留到期检查拒绝激活（§5.3b 残余 1） |
| 用户在 worker mint 前被提升为 admin | worker 第 7 步读到 admin → resolved、0 token/投递/SMTP |
| 公开受理时 admin、worker mint 前降级 | 公开路径不保存角色快照；worker 锁定读取 non-admin 并可 mint/投递，符合 §2.3 的权威边界 |
| worker / 事务 A / 事务 B 任一处读到 admin 后再降级 | resolved/cancelled 状态不可逆，不复活旧 request/candidate；必须新请求 |
| worker 崩溃 / 租约过期后重试 | 第 2 步 `resolved_at` 非空 → 成功 no-op；不重复 mint、不重复入队投递 |
| 同一 intake 被两个 worker 同时 claim | claim 校验 + 等锁后复检，只有持有效租约者继续；另一个成功 no-op |
| mint 预算并发计数 | 计数与 mint 在同一持锁事务内，**精确**，无超发、无多计 |
| 两个清理事务并发 | 两者只选择 `resolved_at is not null` 的行；`for update skip locked` + 确定性排序键 `(greatest(...), id)`：互不阻塞、无死锁；被跳过的行留给下一次任务 |
| 清理与 pending / processing / retryable handler 并发 | 未解析行不满足清理谓词，即使超过 retention 也不会被删除；handler 引用的 durable state 一直保留到主事务提交 `resolved_at`。真实 PostgreSQL 竞态测试固定该边界 |
| 清理与预算窗口交互 | 删除谓词覆盖 `minted_at` 滞后，并由 §5.7 的保留期不等式保证严格覆盖预算窗口 + 超龄界 |
| SMTP 后旧 claim 过期、重复 claim | 旧 claim 激活 no-op；新 claim 对同 candidate 至少一次重发并激活。任何 stale claim 均不能 supersede |
| 激活后任务完成前崩溃 | 重试走 active-delivered 恢复分支并幂等完成，不重复 SMTP/supersede/event；best-effort event 可缺失，不参与 correctness |
| 旧 candidate SMTP 阻塞，较新 candidate 先激活 | 旧事务 B 在 pending+active eligible 集合中看到更大 `(created_at,id)`，只把旧 candidate → superseded；较新 active 保持可用，旧任务 terminal success/no-op |
| 多个 eligible replacement（异常/人工恢复） | 在 pending+active、未消费/未 supersede 集合中 `(created_at,id)` 最大者才可激活；旧 candidate → superseded，其任务成功 no-op；不得覆盖更新 active token |
| pending token cleanup 与投递/人工 retry 并发 | cleanup 先锁 terminal task 再锁 token；processing/retryable/已被 `retryTask()` 恢复的 task candidate 不可选。与 claim/激活通过 task/token 行锁串行 |
| task 终态提交与 cleanup hook/reconciler 并发 | `markTaskDead`/failed-to-dead/final sweep 先提交，再触发 hook；多个 cleanup 用 `SKIP LOCKED`/幂等谓词收敛。hook 失败或进程崩溃由后续周期 scan 重试 |
| 多实例 | 公开路径无共享内存状态；mint 预算是数据库计数，跨实例**精确**（相对基线的内存预算是改进） |
| 备份恢复（S7 / `restore/neutralize.ts:290-310`） | 该流程把未列入终态的任务重置为 `pending`（`attempts: 0`、`runAfter: now()`）。被重置的 intake 若已 `resolved_at`，重跑即成功 no-op；若未 resolved，则因 `magic_link_requests.created_at` 是**从备份还原的旧时间**而几乎必然已超龄，走 §5.3 第 5 步。**正确性上安全**（不重复签发、不泄露角色），但**告警上有副作用**：见下 |
| **恢复后的超龄告警突发（F-J）** | 由于上一行的机制，**每次**备份恢复都会让所有在途 intake 同时触发 §5.10 的超龄 `logger.warn`，数量正比于备份时刻的在途 intake 数。而该告警正是 §9.4 / §11.4 指定的「用户看到 accepted 却收不到链接」的**唯一自动检测手段**，因此这是一次确定性的假阳性突发，恰好发生在运营者最关注告警的时刻。**要求**：告警文案中固定包含 `requestId` 与 `ageMs`，使运营者可按时间聚类识别突发；`docs/deployment/` 的恢复流程说明与 §9.4 必须写明「恢复后预期出现一次与在途 intake 数等量的超龄告警突发，可整体忽略」。实现**不得**为此在 `restore/neutralize.ts` 中特殊处理 intake（该文件保持零改动，§2.4），因为按 kind 特判会把恢复语义与认证模块耦合 |

---

## 8. 可用性、吞吐与定向拒绝服务分析

### 8.1 Spacing Lemma

**delivery-aware Spacing Lemma（修订）**：令 `A` 为某邮箱当前已投递、未消费、未自然过期的 active token，`P` 为 replacement pending token。mint `P`、投递 fence 抑制后续请求、SMTP 失败/超时、worker 崩溃或 stale lease 均不修改 `A`。只有 SMTP 成功返回且 §5.3a 的当前 claim、role、pending+active monotonic-candidate 复检全部通过时，单个事务才把 `P` 激活并 supersede 比它旧的 `A`。因此在该事务提交前，`A` 的自然有效期不会被攻击者的替换请求缩短；较旧 SMTP 执行也不能反向替换较新的 active token；提交时，新的链接已经至少一次交给 SMTP，且其 TTL 从激活时刻重新起算。

这是**连续性而非永续可用性**保证：若 `A` 在 replacement 成功激活前自然过期或被合法消费，协议不保证此后仍有可用链接；若最初就没有已投递 active token，SMTP/队列故障也可能使用户一直没有链接。数据库与 SMTP 不能原子提交，因此「SMTP 返回成功」只表示 provider 接受，不证明最终进 inbox；本规格不作该不可实现的保证。

默认 `S = REQUEST_CODE_SEND_DEDUPE_SECONDS = 60 s`，`TTL = 900 s`。`S ≤ TTL` 仍是正常发送频率的安全配置，越界继续由 `assertRuntimeSecurity()` 启动告警；但即使满足该不等式，也不得再推导「任意时刻必有未过期链接」。pending fence 的持续时间由 delivery task retry/dead-letter 生命周期决定，而不是由 `S` 证明。

**反例（为什么不能用按窗口计数的纯目标预算）**：若改用「每窗口 `W` 最多 `C` 次」的纯 email 预算，攻击者可在窗口开始处连续消耗全部 `C` 次（受 `S` 约束需 `C·S` 秒），此后直到 `t = W` 都无法签发。最后一条链接在 `C·S + TTL` 后过期，于是 `[C·S+TTL, W]` 区间内受害者既无有效链接也无法获得新链接。默认参数下这是约 40 分钟的可用性拒绝。**因此按计数的目标预算只在 key 绑定请求者自身可信 IP 时才可安全启用**（§5.6）。

**投递持续失败**：delivery task 最终 dead-letter；pending candidate 在调查/重试保留期内保持不可消费，之后由 post-finalization reconciler 最终回收。旧 active token仅存续至其自然 expiry/consume。用户之后需重新请求；这由邮件任务 dead-letter 告警覆盖。关键改进是失败不会**提前**废除旧链接，而不是声称失败期间永远可登录。

### 8.2 intake 吞吐预算（F184-08）

单实例 dispatcher（ADR 0003）每个 tick 串行处理至多 `TASK_BATCH_SIZE = 20` 个任务，timer 间隔为 `TASK_POLL_INTERVAL_MS = 10 s`（`src/modules/tasks/index.ts:31-32`，`dispatcher.ts:176-199`）。只有在整批执行时间不超过 10 秒且每批填满时，名义上限才是 **2 任务/s ≈ 7 200 任务/小时**；handler 较慢或其它类别占槽时实际吞吐更低。按 `env.ts:49-51,59` 的默认名额：

| 类别 | 每批策略 | 名义每小时量 | 承载（`queue-class.ts` `QUEUE_DEFAULTS` 实况） |
|---|---|---|---|
| `transactional` | 保底 8 | 2 880 | `auth.login_code_email`(0)、`auth.magic_link_email`(0)、`email`(10)、`subscription.renewal_reminder`(10) |
| `default` | 保底 2 | 720 | `publish_post`(20)、`payment_provider_event.dispatch`(20)、`subscription.reconcile`(30) —— **v3 不再往这里放 intake**（§5.3 / F-B） |
| `notification` | 保底 2 | 720 | `notification.*` |
| `maintenance` | 上限 2 | ≤ 720 | `file.cleanup_orphan`、`storage.delete_object`、`payment_proof.cleanup` |
| **`auth_intake`（新增）** | **上限 `TASK_AUTH_INTAKE_MAX_PER_BATCH` = 4** | ≤ 1 440 | **仅 `auth.magic_link_request`** |

`auth_intake` 用的是**上限**（如 `maintenance`）而不是保底。dispatcher 必须先保护既有 `transactional` reserved、`notification` minimum 与 `default` minimum，再只让 intake 竞争剩余槽；因此 intake 不得把这三项压到其配置保证以下。它仍会占用共享的 20 槽，并可能减少其它类别超出保证值的机会吞吐；`maintenance` 本来只有上限、没有保底，也可能拿不到槽。默认每批至多 4 个对应的 **1 440 intake/小时只是空闲、快速 handler 条件下的名义容量，不是硬吞吐保证**。

**饱和条件（明确陈述）**：当 intake 到达率持续高于 dispatcher 在当时混合负载和 handler 时长下实际给 `auth_intake` 的服务率时，该类就会积压；首次执行等待超过 `MAGIC_LINK_REQUEST_MAX_AGE_MINUTES`（默认 30 min）的行开始批量走超龄分支，**Magic Link 登录整体降级**。在空闲 dispatcher、满 4 intake/批且批次不延长 tick 的理想条件下，名义边界约为 1 440/小时；按默认 `REQUEST_CODE_IP_RATE_MAX = 20/小时/IP` 粗算，需要约 72 个持续打满的可信来源 IP。**这只是容量规划例，不是攻击成本下界**：既有任务负载或慢 handler 会降低服务率，所需来源数也随之下降。出厂默认 unresolved 桶的 100/窗口低于理想名义容量，但规格不得据此声称积压不可达；共享 dispatcher 的现有负载仍可能使实际容量低于该到达率。

**与 v2 相比的关键改进**：
1. intake 移出 `transactional`（§5.3），因此其 FIFO backlog 不会排在已签发链接投递或验证码 fallback 前面，且 dispatcher 的 transactional reservation 保持；共享 batch / 数据库成本造成的有限机会吞吐影响仍按本节明确保留；
2. 超龄不再是静默的成功 no-op，而是带告警的可观测终态（§5.4 / §5.10），运营者能看到降级；
3. 超龄界与重试时限解耦，正常瞬时故障不再被误判为超龄（§5.4）。

**对不变量 3 的结论**：专用类别把攻击者制造的 FIFO backlog 隔离在 Magic Link intake 内，并以 4/批限制它对共享 dispatcher 的占用；它不把 intake 处理成本消除，也不提供 72-IP 的硬安全边界。强攻击者或较高既有负载仍可造成 intake 延迟或超龄，并使其它类别损失保证名额以外的机会吞吐；这是明确接受的容量型 DoS 残余，而不是按目标邮箱耗尽某一受害者有用登录容量的机制。降级对 admin / member / unknown 一致，不产生角色信号（§8.3）。运营上必须监控 `auth_intake` 队列深度、实际 claim/service rate、batch 执行时长与超龄告警，并只能在容量测量后调整 `TASK_AUTH_INTAKE_MAX_PER_BATCH`。

### 8.3 降级不产生角色信号

超龄、队列积压、intake dead-letter 全部发生在公开请求路径**之后**，且判定输入（`created_at`、队列深度）与目标邮箱的角色无函数依赖。公开响应在所有这些状态下都是同一个 `200 accepted`（§6.1 第 9–11 行）。因此可用性降级不构成 §3 威胁模型下的区分信号。

### 8.4 逐项 DoS 结论

- **跨来源锁死**：不可能。mint 预算含请求者 IP；公开路径无任何目标相关预算。
- **使受害者手上的链接提前失效**：不能通过 mint、排队或 SMTP 失败实现；旧 active token 只在 replacement 已经 SMTP 成功且围栏激活事务提交时 supersede。旧 token 自然过期/消费后的空窗不在保证内。
- **未经请求的邮件**：攻击者可从自己 IP 触发投递（基线既有行为）。上限见 §11.1。
- **队列淹没**：见 §8.2 的定量分析与阈值。
- **表膨胀**：由 §5.7 的有界清理与保留期约束；`app_events` 增长见 §11.2。

---

## 9. Schema、Migration、发布与回滚

### 9.1 Migration

- 新增 `src/db/migrations/0031_magic_link_requests.sql`（当前最新为 `0030_wp3_membership_entitlements.sql`），内容为 §5.5 与 §5.5a 的 DDL/backfill，并重建 `tasks_queue_class_check` 以加入 `auth_intake`。
- 同步更新 `src/db/migrations/meta/_journal.json` 与 drizzle 生成的 snapshot（由 drizzle-kit 生成，不手写）。
- `tasks.kind` 是 `text` 列（`src/db/schema/index.ts:654`），新增任务种类不需要枚举迁移；但 `queue_class` 有 check 约束，因此 migration 必须在同一事务中删除并按完整新集合重建 `tasks_queue_class_check`，加入 `auth_intake`。
- `src/modules/__invariants__/db-reset.ts` 的显式 truncate 列表（`:11-45`，其注释要求「Keep this list aligned with the application tables exported from the current schema」）**必须**加入 `magic_link_requests`；否则集成测试的 `beforeEach` 会留下残行，使按 `(email, ip)` 计数的切片 1–4 变成顺序相关的 flaky 测试（F184-09）。
- 按 §5.5a 对既有 token 做保守 active/delivered 回填，`delivery_reservation_until` 全部保持 `null`（既有行都不是 pending，也没有在途投递）；不延长 expiry、不删除数据。兼容默认值保证旧实例在 migration 后创建的 token 同样是 active/delivered，因此可在滚动发布中先于新代码执行。post-finalization hook/reconciler 不需要新表或 schema：它只读取既有 versioned task payload 与 token lifecycle；migration 后、代码部署前的 legacy tasks 因无 `deliveryProtocol: 2` 必须被排除。

### 9.2 发布顺序（F184-02：必须用发布门，不能裸滚）

**为什么裸滚不安全**：`claimOneTaskForClass` 只按 `queue_class` / `status` / `run_after` 选取任务，**与 kind 无关**；未升级实例领到 `auth.magic_link_request` 后，`runTaskHandler` 落到默认分支抛 `PermanentTaskError("Unsupported task kind")`（`tasks/handlers.ts:409-411`），而 `dispatchClaimedTask` 把 `PermanentTaskError` 在**首次**尝试就映射为 `markTaskDead`（`tasks/dispatcher.ts:83-86`）。**没有重试**。后果：用户收到 `accepted`，链接永远不会发出。v2 §9.2 声称最坏情况只是「短暂多签发一条链接」，那是错的。

因此发布必须分三步，由 `MAGIC_LINK_INTAKE_ENABLED`（默认 `false`）作为门：

1. **Phase 0 — migration**：执行 `0031`，完成 token lifecycle 回填并核对「migration 前 `consumed_at is null and expires_at > now()` 的 token 数量 = migration 后同一 consumed/expiry 谓词且 `delivery_state='active' and delivered_at is not null` 的 token 数量」。不得拿全部 active 行比较，因为历史 expired/consumed 行也保守回填 active。记录 migration 前 `auth.magic_link_email` 的 pending/processing/retryable failed legacy 任务清单，升级后逐项确认仍按 legacy v1 SMTP 路径完成而非 active-recovery 跳过。旧代码忽略新表，并由兼容默认值继续创建 active/delivered token。
2. **Phase 1 — 全量部署新镜像，`MAGIC_LINK_INTAKE_ENABLED=false`**。此时每个实例都**已注册** intake handler（能安全处理该 kind），但公开路径仍走基线同步逻辑并创建无 `deliveryProtocol` 的 legacy v1 投递 payload，因此队列中不会出现任何 intake 行，也不会把 active/default token 误走 v2 recovery。等到全部实例完成滚动、确认无旧版本在跑，并用一次 Phase 1 baseline 请求实际验证 SMTP 被调用。
3. **Phase 2 — 置 `MAGIC_LINK_INTAKE_ENABLED=true`**（环境变量变更 + 重启/滚动）。公开路径开始写 intake 行；此时不存在会把它们 dead-letter 的实例。

单进程 / 单容器部署（`docker-compose.yml` 的默认拓扑）可以把 Phase 1 与 Phase 2 合并为一次部署，因为不存在新旧实例共存的窗口——但必须**先跑完 migration**。

**Phase 1 期间的安全状态**：`MAGIC_LINK_INTAKE_ENABLED=false` 时，#184 描述的跨请求区分器仍然存在（等同基线）。这是发布窗口内的已知暴露，不是长期选项。实现 PR 必须同时登记一个后续 issue：在下一个版本把默认值翻为 `true`、删除基线同步分支与该开关，使代码只剩一条路径。

**双路径的测试义务**：只要开关存在，两条路径都必须有测试覆盖（§10 切片 5 测试 26）。

### 9.3 回滚顺序（按序执行）

`getEnv()` 会在进程内缓存解析后的环境变量，因此**只修改部署平台中的环境变量不会让正在运行的实例立刻切换路径**。回滚必须把「关闭开关」视为一次需要重启/滚动的配置发布：

1. **将 `MAGIC_LINK_INTAKE_ENABLED=false` 写入部署配置，并完成所有新镜像实例的重启/滚动**。逐实例确认新进程已读取到 `false`；在所有实例完成前，仍可能有旧进程继续创建 intake 行，**不得开始以“已停止写入”为前提的排空判断**。
2. **确认停止新增后再排空可重试工作**：观察 `magic_link_requests`、`auth.magic_link_request` 与引用 `delivery_state='pending'` candidate 的 `auth.magic_link_email` 任务，确认没有新的 intake 行持续产生；已有任务仍由当前新镜像 handler 正常处理。先等待 intake 与 delivery-aware 投递任务不存在 `pending` / `processing` / 可重试 `failed`，并确认所有 candidate 均已 active 或 terminal。此时**不得直接要求全部 `resolved_at is null` 清零**：§5.7 有意保留 dead intake 对应的未解析行，单纯等待会让紧急回滚永久卡住。
3. **显式处置 dead intake（回滚门，必须逐项留证）**：对每个 `kind='auth.magic_link_request' and status='dead'` 的任务，从其 versioned payload 解析 `requestId`，并把任务 ID、request ID、`last_error` 与处置选择写入运营记录。只有两种允许的选择：
   - **重试**：在新镜像仍运行时使用既有受鉴权的任务管理重试操作 `retryTask(taskId)`（它把 `dead`/`failed` 原子恢复为 `pending`、`attempts=0`），然后回到第 2 步等待正常解析；不得直接用 SQL 改 task 状态或伪造 lock token。
   - **明确放弃本次已接受请求**：仅当同一事务锁住 dead task 与 request 行，并验证 `resolved_at is null`、`minted_at is null`、`minted_token_id is null`，且不存在由该 request 引用的 token/candidate 或 `auth.magic_link_email` 任务时，才可把 request 行置 `resolved_at=now()`，并保留 dead task 和运营记录作为审计证据。该操作表示此请求不会投递，受影响用户必须在回滚后重新请求；不得删除 request/task，不得把它伪装成成功发送。任一安全谓词不满足都属于 durable-state invariant violation，**阻断镜像回滚**并要求人工调查，而不是强制 disposition。

   回滚 drain 的规范谓词因此是：**无可重试 intake/delivery-aware 任务；无未处置 dead intake；无仍由 live/retryable delivery task 引用的 pending candidate；terminal protocol-v2 task 的合格 pending candidate 已经 post-finalization reconciler 清空**。开始镜像回滚前必须显式运行/等待一轮 terminal-candidate reconciler 并复查；cleanup 暂时失败会阻断 drain，而不是忽略 pending 行。它不是裸的 `count(*) from magic_link_requests where resolved_at is null = 0`。处置事务与 task→token/request 锁顺序必须复用 §5.3a/cleanup 的同向顺序，避免与仍在结束中的 handler 形成反向等待。
4. 若要回滚**镜像**：必须在第 2–3 步完成之后再滚动到旧镜像。否则残留的 intake 任务会被旧镜像在**首次尝试**就 `markTaskDead`（机制同 §9.2），对应用户永远收不到链接——v2 §9.3 声称它们「会持续失败直至 dead」、运营者可「直接标记为 dead」，两句都与代码不符：它们**已经**是 dead，且只经历了一次尝试。受影响用户需重新发起请求。
5. 可选：`drop table magic_link_requests;`（保留该表不影响旧代码）。

回滚会**恢复** #176 记录的跨请求区分信号与按邮箱 429，必须在回滚说明中写明。

### 9.4 运营兼容性与监控

- 新环境变量都有默认值；`MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX` 未设置时回落到运营者当前的 `REQUEST_CODE_EMAIL_IP_RATE_MAX`（§5.8），升级不会静默放宽已调低的配额。
- **行为变化（须在 CHANGELOG 声明）**：(a) 开关打开后 Magic Link 邮件比基线晚一个 dispatcher 周期；(b) 按邮箱预算耗尽不再返回 429，只返回 accepted；(c) Magic Link 不再消费验证码流程的共享桶；(d) `magic_link_requested` 事件 payload 由 `{tokenId, keyId, emailDigest}` 变为 `{requestId, emailDigest}` 且每请求一条；(e) 新增一张按请求增长、保留期默认 24 小时的表。
- **监控（F184-03，已修正）**：`MailTaskFailureCounts`（`src/modules/tasks/index.ts:45-49`，统计逻辑在 `:629-634`）只覆盖邮件类任务，**不含** intake。因此本 Issue **要求实现**把 `auth.magic_link_request` 纳入 dead-letter 告警面（§5.10），并把 §5.10 的超龄告警接入同一日志通道。**在这两项落地之前，「用户看到 accepted 却收不到链接」没有任何自动检测**——运营者只能人工查看 `/admin/tasks`。v2 声称「由通用 dead-letter 告警覆盖」是错误的：`warnMailTaskDeadLettered()` 对非邮件类 kind 直接返回（`src/modules/tasks/index.ts:53-55`）。
- **恢复告警说明（F-J）**：恢复流程会让备份中的在途 intake 以旧 `created_at` 重新执行，因而预期产生一次与在途数量相当的超龄告警突发。部署/恢复文档必须提示运营者按恢复时间窗口整体识别并忽略该突发；`src/modules/restore/neutralize.ts` 保持不修改。
- **回滚 dead-intake 处置**：部署 runbook 必须提供 §9.3 第 3 步的清单查询、受鉴权 `retryTask(taskId)` 路径与经安全谓词保护的明确放弃事务；每次处置都记录 task/request ID、错误和选择。不得把 dead intake 从 drain 中静默排除，也不得要求一个因 dead 行有意保留而不可达的裸 `resolved_at is null = 0`。
- **terminal candidate cleanup 监控**：必须监控 terminal protocol-v2 delivery task 仍引用 pending candidate 的数量、最老 `tasks.updated_at` 与 reconciler 失败计数。非零可短暂存在于保留/调查窗口；超过配置窗口或持续失败必须告警，且在回滚 drain 中为阻断项。
- 建议运营者为 `magic_link_requests` 行数、`auth_intake` 队列深度与 intake 超龄告警建立面板；饱和阈值见 §8.2。
- **`app_events` 保留**：见 §11.2。

---

## 10. TDD 实施切片

**强制流程**：每个切片先写测试并**实际运行**观察 RED，把失败输出（测试名 + 断言消息）记入 PR，再写最小实现转 GREEN。禁止推断式「应该会失败」。全部证据绑定实现分支 exact head。

数据库测试统一 `RUN_DB_INTEGRATION_TESTS=true`，沿用 `describeWithDatabase` + `resetDatabase(db)`（**须先按 §9.1 加入新表**）+ `beforeEach` 清理；并发等待一律用既有 `waitForBlockedQuery()` 式 `pg_blocking_pids()` 有界轮询，**禁止固定 sleep**。除特别说明外，测试均在 `MAGIC_LINK_INTAKE_ENABLED=true` 下运行。

### 切片 1：latency-class 等价的公开路径（核心）

1. **`公开请求不获取按邮箱锁、不读取目标状态`（load-bearing）**：用保留连接开启控制事务，取得 `pg_advisory_xact_lock(hashtext(email))`，并对该邮箱的 `users` 行与活跃 `magic_link_tokens` 行执行 `SELECT ... FOR UPDATE`；在**不释放**的情况下调用 `requestMagicLink()`，断言其在有界时限内**正常返回**。基线会阻塞在 advisory lock 上直至超时 → RED。这是对 G2 的确定性证明，不依赖计时统计。
2. **`admin / member / unknown 的公开路径持久足迹逐项相等`**：三类邮箱各请求一次（worker 不运行），断言各自恰好 1 行 `magic_link_requests`、1 个 `auth.magic_link_request` 任务、**0 行** `magic_link_tokens`、**0 个** `auth.magic_link_email` 投递任务。
3. **`magic_link_requested` payload 键集合精确等于 `{requestId, emailDigest}`**，且每个请求恰好一条。
4. **`intake 任务的队列类别、优先级、上限与共享 batch 公平性`**：断言新建任务的 `queue_class = 'auth_intake'`、`priority = 0`；验证 dispatcher 每批领取不超过 `TASK_AUTH_INTAKE_MAX_PER_BATCH`。在五类均积压时，精确断言 `transactional`、`notification`、`default` 分别至少获得其 configured reserved/minimum，intake 不超过 cap，maintenance 仍只有 cap 而无保底；另断言 intake 会占共享 batch 槽，测试不得把 4/批误写成独立于其它类的额外容量。

### 切片 2：worker 解析（角色 / dedupe / fence / 锁顺序 / 列传播）

5. `admin intake 被解析为不签发`：`resolved_at` 非空、`minted_at` 为空、0 token、0 投递任务、0 邮件；管理员用户 `role`/`locale`/`last_login_at`/`updated_at` 全部不变。
6. `member / unknown intake 创建 pending candidate 并入队投递任务`：SMTP 前 verify/consume 均 invalid；SMTP 成功且围栏激活提交后才可验证、消费，TTL 从激活时刻起算。
7. `dedupe 与 delivery fence 语义保持`：pending candidate + 投递任务处于 `pending`/`processing`/可重试 `failed` 时不再签发；缺投递任务时告警并保守抑制；最近 `delivered_at` 位于 spacing 窗口时不签发。每条路径均断言旧 active token 不变。
8. **`不签发成因在数据库中不可区分`（F184-15）**：分别构造 admin 抑制与 dedupe 抑制各一行，断言两行在**除 `id` / `email` / 时间戳以外的每一列**上取值相同（尤其 `minted_at` 与 `minted_token_id` 同为 `null`）；并断言 `magic_link_requests` 的列集合与 §5.5 完全一致，防止未来新增原因列。
9. **`列传播端到端`（F184-10）**：以 `next=/members/x` 发起请求 → intake → mint → 投递 → 消费，断言 `magic_link_tokens.redirect_path`、`ip`、`user_agent` 来自 intake 行，消费返回的 `redirectPath` 为 `/members/x`；另加一例存入非法 `redirect_path` 的历史行，断言 mint 时被 allowlist 拒绝为 `null`。
10. **`locale 重校验`**：intake 行存入非法 locale（如 `"xx"`），断言 mint 后投递 payload **不包含 `locale` 键**，由既有投递链路在 `undefined` 时选择默认 locale，且投递任务不因 zod 严格校验而 dead-letter。
11. `intake 首次 claim 时超龄不签发且发出告警`：构造 `attempts = 1` 且 `created_at` 早于 `MAGIC_LINK_REQUEST_MAX_AGE_MINUTES` 的 intake，断言 resolved、未 mint，且捕获到 §5.10 的超龄告警。
12. `锁顺序为 advisory → token → user`：控制事务先锁 `users` 行，用 `pg_blocking_pids()` 轮询断言 worker 阻塞在 `users` 的 `FOR UPDATE`；提交后按当时角色决策。

### 切片 3：持久 mint 预算、保留期与清理

13. `mint 预算精确且按 (email, ip) 隔离`：同一 IP 连续签发至上限后 `minted_at` 计数不再增长，**换一个 IP 立即可签发**。
14. `unresolved intake 跳过计数预算但仍受 spacing bound 约束`：`ip` 为空的 intake 在 dedupe 窗口外可持续签发，窗口内不签发。
15. `未设置时回落到 REQUEST_CODE_EMAIL_IP_RATE_MAX`：直接测试 `rate-limit-policy.ts` 的生效上限助手，覆盖「都未设 → 5」「只设 `REQUEST_CODE_EMAIL_IP_RATE_MAX=2` → 2」「显式设 `MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX=7` → 7」；不得通过修改 `assertRuntimeSecurity()` 入参来伪造值推导。
16. **`保留期跨字段校验 fail closed`**：断言 `assertRuntimeSecurity` 抛出的**具体错误信息**（不只是「抛错」），覆盖 §5.7 不等式的边界：`RETENTION_HOURS=1` + `REQUEST_CODE_RATE_WINDOW_MS=3_600_000` + `MAX_AGE=30` 必须**失败**（3 600 000 < 3 600 000 + 1 800 000），`RETENTION_HOURS=2` 必须通过。
17. **`超龄只在首次 claim 生效`（F184-01，load-bearing）**：同一陈旧 intake 在 `attempts = 1` 时必须 resolved + 告警且不 mint；构造它已在 age policy 内完成首次 claim、随后失败，并在 `attempts > 1` 时把 `created_at` 回拨到超龄，重试仍必须进入正常判定而不是 age rejection。该测试不得以固定 `RETRY_HORIZON_MS` 代替 attempts 语义。
18. **`dedupe 越界只告警不失败`**：`REQUEST_CODE_SEND_DEDUPE_SECONDS=1800` 时 `getEnv()` 成功但输出 spacing/TTL 配置告警；测试不得把它命名或断言为「任意时刻有可用链接」。
19. **`清理只删除已解析行，且在主事务之外`**：控制事务锁住一批旧的已解析行；断言 mint 主事务照常提交（`for update skip locked` 跳过被锁行），清理只删未被锁的已解析行且每次不超过 200 行；断言删除谓词覆盖 `minted_at` 滞后的行（`created_at` 已过保留期但 `minted_at` 未过的行**不**被删除）。另构造超过 retention 的 `pending`、`processing` 与可重试 `failed` intake，分别与清理并发，断言其 `magic_link_requests` 行始终存在、handler 可继续读取并最终写入 `resolved_at` / `minted_at`，不会走 `request row missing` no-op；该测试必须使用真实 PostgreSQL 的锁/阻塞观测，不用固定 sleep。

19a. **`handler 锁定 intake 行`（F-N）**：让 handler 在第 2 步取得 intake 行锁后、第 3 步取得 advisory lock 前阻塞；并发运行一个**谓词被人为放宽为不含 `resolved_at is not null`** 的清理事务，断言它因 `for update skip locked` 跳过该行、handler 释放后仍能正常写入 `resolved_at` / `minted_at` 且影响行数为 1。同一用例在 handler 使用普通 `SELECT` 的实现下必须 RED（放宽后的清理会删掉该行，mint 随后退出 §5.6 预算计数）。

### 切片 4：重试时限、崩溃、并发（真实 PostgreSQL）

20. **`四次失败后第五次即使已超龄仍能签发`（F184-01，load-bearing）**：以可控失败注入使 intake 前 4 次执行失败（至少覆盖一次 stale lease reclaim），把 `created_at` 回拨到明显超过 `MAGIC_LINK_REQUEST_MAX_AGE_MINUTES`，断言第 5 次 claim 因 `attempts > 1` **仍然 mint**，而不是落入首次执行超龄分支。若实现对每次重试重复应用 age check，该测试必须失败。
21. `已 resolved 的 intake 重试为成功 no-op`：不产生第二个 token、第二个投递任务或第二封邮件。
22. `陈旧 claim 不 mint`：以过期租约 / 错误 lockToken 调用处理函数，返回成功 note，0 token。
23. `同邮箱两个 intake 并发处理`：恰好 1 token、1 投递任务；两个 intake 都被标记 resolved。
24. `admin 邮箱两个 intake 并发处理`：0 token、0 投递任务。
25. `worker 主事务失败整体回滚`：以只作用于 `magic_link_tokens` INSERT 的测试触发器制造失败，断言 `resolved_at` 未置位、无投递任务；移除触发器后重试可正常签发。
26. **`intake dead-letter 触发告警`（F184-03）**：把 intake 任务推到最终失败，断言 §5.10 要求的告警被发出（基线的 `warnMailTaskDeadLettered` 对该 kind 静默 → RED）。

### 切片 4a：delivery-aware replacement（真实 PostgreSQL，load-bearing）

26a. **`pending 不可验证/消费`**：直接提交 pending candidate，按 hash 与 id 两条查询均得到统一 invalid，0 session、0 consume event。
26b. **`SMTP 失败保留旧链接`**：先构造已投递 active token，再让 replacement SMTP 抛瞬时错误与 permanent 错误；两种情况下旧 token 均可 verify/consume 到其自然 expiry。瞬时失败及 permanent handler 返回而 task 尚未提交 dead 时 replacement 保持 pending；dead 提交后的删除时点由 26l/26n 的保留期与 reconciler 测试固定。
26c. **`成功发送后原子切换`**：在 SMTP mock 返回后、激活提交前阻塞事务，断言旧 token 仍 active、新 token invalid；释放后断言 replacement active、`delivered_at` 非空、TTL 从激活时刻起算、旧 token superseded，且不存在观察到二者都不可用的数据库提交态。
26d. **`SMTP 后激活回滚`**：用触发器令 supersede 或 candidate active UPDATE 失败，断言整个事务回滚：replacement pending、旧 token active、任务可重试；移除触发器后同 candidate 收敛。best-effort event 不在该事务内，不得用它伪造回滚条件。
26e. **`SMTP 后 stale lease 不激活`**：发送完成后令 lease 过期并由另一 worker reclaim；旧 claim 激活 no-op、旧 token仍 active。新 claim 重发同 token 后激活；0 第二 candidate。
26f. **`SMTP 后崩溃允许同 token 重发`**：模拟第一次 SMTP 成功后进程终止、事务 B 未执行；重试 payload/tokenId 完全相同，可出现两次 send 调用，但仅一次 active transition；`magic_link_sent` 只允许在该 transition 提交后出现。
26g. **`激活后任务完成前崩溃不重发`**：事务 B 已提交而 task 仍 processing；重试必须命中事务 A 的 active-delivered 恢复分支，0 新 SMTP 调用、0 重复 supersede/event，任务幂等 succeeded；覆盖激活后、event 前崩溃造成的 best-effort event 缺失，断言不影响 token/task correctness。
26h. **`pending + active monotonic-candidate fence`**：人工构造两个 candidate 与各自任务，强制旧任务在 SMTP 中阻塞，让新任务先完成 SMTP 并激活，再释放旧任务；旧事务 B 必须看到更新的 active candidate，只 supersede 自己并 terminal success/no-op，绝不 supersede 新 active，后者链接仍可 verify/consume。另覆盖两个都 pending 的顺序，以及相同 `created_at` 用 `id` 决胜。使用真实 PostgreSQL 锁/有界阻塞观测，禁止 sleep。
26i. **`激活与消费并发`（load-bearing）**：用真实 PostgreSQL 行锁分别强制两种顺序。(a) 旧 token consume 先提交：断言事务 B **不激活**、candidate 终态为 `cancelled`、`delivery_state` 从不为 `active`，且该 candidate 此后按 hash 与 id 两条查询均 invalid；(b) replacement activate 先提交：断言旧 token superseded、其消费返回 invalid。两种顺序都断言 `total session ≤ 1`、无死锁，且任务均为 `succeeded`（终态 no-op 不是失败）。必须另有一个**反向断言**用例：把事务 B 的锁集合人为限制为「仅未终态行」时 (a) 必须产生 2 个 session —— 该用例固定 §5.3a F-P 的必要性，实现回退到状态过滤锁即 RED。
26o. **`晋升围栏`（F-Q，load-bearing，真实 PostgreSQL）**：(a) 事务 A 提交后阻塞在 SMTP，并发调用 `setupSite()` 与 `changeAdminEmail()`，断言两者都以可重试错误回滚、`users.role`/`users.email` **未变更**、candidate 未被改写；释放 SMTP 后事务 B 正常激活。(b) 把预留时间回拨到已过期，重复 (a)，断言晋升成功提交、candidate 被置 `cancelled`，随后事务 B 因预留到期检查拒绝激活且 0 session。(c) 事务 A 之前晋升：0 SMTP 调用（用 mock 计数断言，而不是只断言 token 状态）。(d) 无 pending candidate 时晋升不受影响，不因围栏产生额外失败。(e) 改管理员邮箱时新旧邮箱各自的 advisory lock 顺序固定，两个并发改名事务不死锁。
26p. **`事务 B 持 task 行锁`（F-O）**：在事务 B 完成全部复检、尚未提交时，令租约过期并让另一 worker 走真实 claim 路径、同时触发 `sweepExpiredFinalAttemptTasks()`；断言两者都**跳过**该 task（`SKIP LOCKED`），事务 B 提交后不存在「active token 对应 dead task」的状态。另以普通 `SELECT` 版本的实现做反向断言：该版本必须能重现被抢占后仍激活的坏状态，从而证明行锁是 load-bearing 而非装饰。
26j. **`admin 晋升/降级时间矩阵`**：真实 PostgreSQL 确定性覆盖：(a) 受理时 admin、intake 锁定前降级 → 可 mint/投递；(b) 受理时 non-admin、intake 前晋升 → resolved 且 0 token/投递/SMTP；(c) mint 后、事务 A 前晋升 → cancelled、0 SMTP；(d) 事务 A 后、事务 B 前晋升 → SMTP 可发生但 B cancelled、0 active/event/session；(e) B 锁定 non-admin 并提交后才晋升 → active 可存在但消费 invalid、0 session；(f) 任一 admin cancellation 后降级 → 不复活/不重发。测试名称与断言必须明确 §2.3 已 supersede #176 的 request-time temporal wording。
26k. **`迁移/backfill 与滚动兼容`**：在 pre-migration fixture 上升级，既有未过期 token仍可验证且 expiry 未延长；模拟旧代码省略新列 INSERT，默认得到 active + delivered_at；模拟新代码显式 pending + null。断言枚举 CHECK、state/timestamp CHECK 与索引存在，并分别尝试插入 `pending + delivered_at`、`active + null`，两者必须被 PostgreSQL 拒绝。
26l. **`pending cleanup 引用安全与 post-finalization`**：processing/可重试 failed/刚由 `retryTask()` 恢复的 task 引用的 pending candidate 不删除；permanent SMTP handler 抛错时 task 仍 processing 且 candidate 保留，随后 `markTaskDead` 提交后 hook 才可删除合格过期 candidate；分别覆盖 `markTaskFailed` 的 failed-to-dead 与 `sweepExpiredFinalAttemptTasks`。cleanup 与 claim/retry/激活并发按 task → token 行锁串行，不留下 live task 指向已删除 candidate。
26m. **`legacy/v2 协议分流与滚动安全`**：分别构造 migration 前 pending、processing、retryable failed 的无 marker legacy task，以及 Phase 1 baseline 新任务；即使 token 已由 backfill/default 成为 active + delivered，handler 仍必须实际调用 SMTP 并走 legacy completion，绝不命中 v2 recovery。另断言 v2 payload 必须精确含 `deliveryProtocol: 2`，v2 active recovery 不 SMTP，未知版本 permanent fail；使用真实 PostgreSQL task/token 状态。
26n. **`cleanup 锁顺序、失败重试与周期 reconcile`**：控制事务先锁 task 行，断言 cleanup 在 task 上等待且尚未持 token 锁；释放后按 task → token 完成。注入 hook 数据库失败及「terminal commit 后、hook 前崩溃」，断言 task 仍 terminal、candidate 暂存，下一 dispatcher tick 的有界 reconciler 最终删除；连续失败保持下次可选。与激活/人工 retry 并发无死锁，legacy task 不被 v2 pending cleanup 误删。

### 切片 5：发布门、路由测试、env、文档

27. **`MAGIC_LINK_INTAKE_ENABLED` 双路径**：`false` 时公开路径走基线同步逻辑（写 token / 投递任务，不写 intake）；`true` 时只写 intake。`src/lib/env.ts` 必须导出仅测试可用的 `__resetEnvCacheForTests()`；每个用例设置 `process.env.MAGIC_LINK_INTAKE_ENABLED` 后调用它，再执行同一静态导入的模块。不得依赖 `vi.resetModules()` 后只重载 `env.ts`，因为已加载的 `magic-link.ts` 会继续引用旧模块实例。
28. **来源门禁顺序**（既有用例保持）：`rateLimit` 返回 false 时在读 body 之前返回 429，`assertTurnstile` 与 `requestMagicLink` 均未被调用。
29. **默认 unresolved 行为**：不带可信代理头时使用 `request-code-unresolved` 桶，且 `requestMagicLink` 收到 `identity.kind === "unresolved"`、`ip: null`。
30. **路由只消费来源桶**：断言 `rateLimit` 在一次请求中**恰好被调用一次**且参数为来源 key —— 直接固定「公开路径无目标相关限流状态」。
31. **响应恒等**：无论 `requestMagicLink()` 的 `Promise<void>` 如何完成、目标为何类邮箱，路由响应体与状态恒为 `200 {ok:true,data:{accepted:true}}`。
32. env 默认值/边界测试扩展 `AUTH_ENV_KEYS`；断言 `MAGIC_LINK_INTAKE_ENABLED` 只有精确字符串 `"true"` 为真，`"1"` 与 `"TRUE"` 均为假；覆盖 `__resetEnvCacheForTests()`。`.env.example`、`CHANGELOG.md`、#176 handoff 指针（§2.3）同步。
33. **`intake 门与 cap 的 fail-closed 组合`（F-R）**：断言 `MAGIC_LINK_INTAKE_ENABLED="true"` + `TASK_AUTH_INTAKE_MAX_PER_BATCH=0` 使 `getEnv()` 抛出**具体错误信息**；`"true"` + `1` 通过；`"false"` + `0` 也必须通过（门关闭时 `0` 仍是合法配置，不得连带收紧 zod 形状）。
34. **`预留窗口跨字段校验`（F-Q）**：断言 `MAGIC_LINK_DELIVERY_RESERVATION_SECONDS=104` 失败、`105` 通过（`SMTP_WORST_CASE_CALL_MS = 75_000` + 30 000 的边界），并断言具体错误信息。
35. **`SMTP 超时常量漂移守卫`（F-Q）**：同时 import `src/lib/env.ts` 的 `SMTP_WORST_CASE_CALL_MS` 与 `src/modules/mail/index.ts` 导出的实际 `connectionTimeout` / `greetingTimeout` / `socketTimeout`，断言三者之和等于镜像常量。只改 `mail/index.ts` 的超时而不同步 `env.ts` 必须 RED。

**F8 的正面回答**：v3 不需要新的 limiter 内省 API。所有需要精确断言的预算状态都已**持久化**（`magic_link_requests.minted_at` 计数、`magic_link_tokens`、`tasks`），可用 SQL 精确断言；唯一的内存 limiter 是既有来源桶，在路由测试中通过 mock `rateLimit` 精确断言调用次数与参数（`src/app/api/auth/magic-link/request/route.test.ts` 已有该模式）。因此 **`src/lib/rate-limit.ts` 不在文件范围内**，也不新增 test-only 读取器。

### 必须保持绿的既有回归

- #176 §7.3 全部行为保证（正常 member 请求/投递/验证/消费、双健康确认、session 插入失败回滚、持锁者回滚后接管、key rotation、redirect allowlist、confirm Route）；涉及 token 查询/lifecycle 的测试按 active-delivered 协议更新，confirm Route 保持零改动。
- `deliverMagicLinkEmailTask()` 的既有 SMTP 分类、加密 payload 与 fence 回归必须保持；涉及「发送即完成/立即 supersede」的断言按切片 4a 改写，不得删除或降低强度。
- 验证码流程（`request-code` / `verify-code`）全部既有测试零改动、零回归。
- `magic-link.integration.test.ts` 中依赖旧「同步签发」语义的用例需**改写为「请求 + 运行 intake 任务」两步**（不是删除），断言强度不得降低；其中 redirect allowlist 相关断言由切片 2 测试 9 承接，不得在改写中丢失。

---

## 11. 残余风险

### 11.1 未经请求邮件的按邮箱配额上升

基线：Magic Link 与验证码**共享** `request-code-email-ip`（默认 5/窗口/(邮箱, IP)）。v3：Magic Link 使用独立的持久计数（默认回落为同一数值），两者不再共享。因此**单个 (受害者邮箱, 攻击者 IP) 每窗口的认证邮件上限由 5 上升到最多 5 + 5 = 10**。这是消除 §1.3 跨流程 oracle 必须付出的代价（共享即泄漏）。

不变的部分：来源级上限 `REQUEST_CODE_IP_RATE_MAX`（默认 20/IP/窗口，两条路由共享）不变；按邮箱的全局 spacing bound（默认 1 次/60 s）不变，且在多 IP 攻击者面前它才是主导约束。运营补救：调低 `MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX`。

### 11.2 写放大：队列、`magic_link_requests` 与 `app_events`

基线下被 dedupe 抑制的请求不产生任何行；v3 下**每个**公开请求产生 1 行 intake + 1 个任务 + **1 行 `app_events`**。

- `magic_link_requests` 由 §5.7 的有界清理与保留期约束。
- **`app_events` 没有任何清理机制**：我确认仓库中不存在对该表的保留期或裁剪逻辑，本 Issue 也不新增（那会改变 ADR 0002 的遥测语义并扩大范围）。因此在 §3 允许的多 IP 洪泛下，`app_events` 会以每请求一行的速度持续增长。**这是本 Issue 明确接受的风险**：不能通过「只为已签发的 intake 记事件」来缓解——那会重新引入角色相关事件，自毁 §5.10 的理由。运营建议：为 `app_events` 建立独立的保留/归档作业，并把其行数纳入监控。
- 队列吞吐与饱和阈值见 §8.2。

### 11.3 投递时延

链接投递比基线多等一个 dispatcher 周期（intake 任务 → 投递任务）。这是把角色判定移出公开路径的直接代价，也是 latency-class 等价的来源。对请求者的 HTTP 响应无影响。运营者可通过缩短 dispatcher 周期缓解。

### 11.4 用户看到 accepted 却收不到链接

v3 有三条这样的路径：intake 任务 dead-letter、intake 超龄、投递任务 dead-letter。前两条是**新增**的（基线同步签发不存在）。

缓解：§5.10 要求的两项新告警（intake dead-letter、超龄）必须与实现一同落地；在它们落地之前**没有自动检测**（§9.4）。用户侧的恢复手段是重新发起请求。

### 11.5 服务端遥测中的角色相关痕迹

`magic_link_sent` 只对真正投递的链接产生，因而在服务端遥测中隐含「该邮箱不是 admin」。不在威胁模型内（§3），且移除它会破坏投递可观测性；记为已知、已接受的运营侧痕迹。

### 11.6 unresolved 默认部署的反垃圾邮件强度

默认 `TRUSTED_PROXY_HOPS=0` 下不启用按计数的 mint 预算，按邮箱的正常发送频率界来自 spacing/pending fence（默认 spacing 1 次/60 s；实际 pending task 可把间隔拉得更长）。这不影响任何不可区分性保证（G7），但不能被描述为「不造成拒绝服务」：delivery-aware 协议只保证攻击者触发的 replacement、排队或 SMTP 失败不会**提前**废除受害者已有且仍自然有效的 active token；旧 token 自然过期/消费后，持续队列或 SMTP 故障仍可造成无可用链接窗口（§8.1）。未解析部署的反垃圾邮件能力确实弱于配置了可信代理的部署。部署文档应继续推荐配置 `TRUSTED_PROXY_HEADER` / `TRUSTED_PROXY_HOPS`；既有 `warnUnresolvedClientRateLimitIdentity()` 告警保持。

### 11.7 发布窗口内的已知暴露

`MAGIC_LINK_INTAKE_ENABLED` 默认 `false`，因此**引入该特性的版本在运营者手动开启之前并不修复 #184**（§9.2 Phase 1）。这是为避免 F184-02 的 dead-letter 事故所付的代价。必须登记后续 issue 在下一版本翻默认值并删除开关与基线分支。

### 11.8 实现漂移

G2 依赖「公开路径不读取任何目标相关行」；§5.5 的「无原因列」依赖没人新增列。任何后续改动若在公开路径重新加入 `users` / `magic_link_tokens` / `tasks` 查询或按邮箱锁，或在 `magic_link_requests` 增加原因/角色列，都会重新引入区分信号。由切片 1 测试 1（持锁不阻塞）、切片 2 测试 8（逐列相等 + 列集合固定）与 §13 评审清单长期约束。

### 11.9 枚举安全的范围声明

本规格只覆盖 `POST /api/auth/magic-link/request`。**不**声称验证码流程、OAuth、公开页面或邮件投递本身不存在账号存在性或角色信号（NG1）。任何 PR 描述、CHANGELOG 或安全文档都不得据此宣称「本产品不可枚举」。

### 11.10 时序声明的边界

v3 在**结构上**消除了角色对语句序列、往返次数、事务类别与锁竞争的影响。它**不**声称对抗能观测宿主机整体负载、或由异步 worker 造成的二阶资源波动的攻击者——这类信道与本端点的请求处理路径无函数依赖，但本 Issue 未对其进行测量或排除。

### 11.11 晋升围栏的运营代价与边界

§5.3b 用一行持久预留把「晋升」与「在途 SMTP」互斥，代价有三项，必须在 PR 描述与运维文档中如实写出：

- **管理员操作可能被短暂拒绝**：当目标邮箱恰有一次在途 Magic Link 投递时，`setupSite()` 与 `changeAdminEmail()` 会以可重试错误失败，最长重试等待为 `MAGIC_LINK_DELIVERY_RESERVATION_SECONDS`（默认 120 s）。这是**故意**的 fail closed：另一种选择是让运营事务持锁等待一个由外部 SMTP 服务器决定时长的窗口。两条路径都是低频操作，但错误文案必须明确「稍后重试」，不能让运营者以为是配置错误。
- **worker 崩溃会延长该窗口到预留上限**：事务 A 提交后进程消失时，没有任何人清空预留，晋升要等到它自然到期。加大 `MAGIC_LINK_DELIVERY_RESERVATION_SECONDS` 会同步加长这个最坏阻塞时间，因此它不能被「为了保险起见」随意调大。
- **围栏只覆盖数据库内的角色写入**：见 §5.3b 残余 3。同时它不改变 §11.5 —— 成功投递本身仍在服务端遥测里隐含「该邮箱当时不是 admin」。

围栏**不**声称「admin 邮箱在任何情况下都绝不会收到任何邮件」：受理时非 admin、直到投递完成都非 admin、随后才晋升的邮箱会收到一封当时完全合法的链接邮件，该链接此后由消费期 admin guard 拒绝。可声称的是 §5.3a 末尾的排序不变量。

---

## 12. 文件范围

### Spec PR（本 PR）

- `docs/handoff/issue-184-cross-request-magic-link-role-indistinguishability.md`（唯一变更）

不改动任何生产代码或测试。

### Implementation PR（基于当时的 `main` 单独开分支）

| 文件 | 变更 |
|---|---|
| `src/db/schema/index.ts` | 新增 `magicLinkRequests`；为 `magicLinkTokens` 增加 delivery lifecycle 列（含 `delivery_reservation_until`）、约束与索引（§5.5a） |
| `src/modules/site/index.ts` | `setupSite()` 的既有事务内实施 §5.3b 晋升围栏：写 `role: "admin"` 前取 advisory(email)、检预留、取消 pending candidate |
| `src/modules/auth/admin-account.ts` | `changeAdminEmail()` 同上，新旧邮箱各一把 advisory lock，按规范化字符串升序取得 |
| `src/modules/mail/index.ts` | 导出既有三个 SMTP 超时常量供漂移守卫测试断言；**不改变**其数值与传输行为 |
| `src/db/migrations/0031_magic_link_requests.sql` | 新增（§5.5/§5.5a DDL、`delivery_reservation_until` 列与 CHECK、既有 token backfill、queue class 约束） |
| `src/db/migrations/meta/_journal.json` + snapshot | drizzle-kit 生成 |
| `src/modules/__invariants__/db-reset.ts` | truncate 列表加入 `magic_link_requests`（F184-09） |
| `src/modules/auth/magic-link.ts` | 重写 `requestMagicLink()`（含发布门）并改为 `Promise<void>`；新增 intake resolver；mint 显式 pending；delivery payload/handler 分流 legacy v1 与显式 v2，v2 实现 SMTP 后围栏激活；verify/consume 只接受 active-delivered token；导出 terminal-candidate 引用验证/有界删除原语（handler 自身不冒充 post-finalization owner） |
| `src/modules/tasks/queue-class.ts` | 注册专用 `auth_intake` 类及 `auth.magic_link_request` → `{ queueClass: "auth_intake", priority: 0 }` |
| `src/modules/tasks/handlers.ts` | `runTaskHandler` 新增 case + zod payload schema |
| `src/modules/tasks/dispatcher.ts` | 接入 `auth_intake` 类，并按 `TASK_AUTH_INTAKE_MAX_PER_BATCH` 在 claim 前实施类别级上限；在 final-attempt sweep 后调用 terminal-candidate reconciler 调度入口 |
| `src/modules/tasks/index.ts` | 把 `auth.magic_link_request` 纳入 dead-letter 告警面（F184-03 / §5.10）；拥有 `markTaskDead`、failed-to-dead 与 final sweep 提交后的 hook，并实现/调度有界 terminal protocol-v2 candidate reconciler |
| `src/lib/env.ts` | 新增六个变量与镜像常量 `SMTP_WORST_CASE_CALL_MS`；在 `assertRuntimeSecurity()` 内实现保留期、intake 门/cap 组合、预留窗口三项 fail-closed 校验与 dedupe/TTL 告警；导出仅测试使用的 `__resetEnvCacheForTests()` |
| `src/lib/env.auth-rate-limit.test.ts` | 默认值、布尔精确解析、三项跨字段校验（含测试 33/34）、SMTP 常量漂移守卫（测试 35）、告警与 env-cache reset 断言 |
| `src/modules/auth/rate-limit-policy.ts` | 新增纯函数 `getMagicLinkMintEmailIpMax(env)`，实现 optional mint 上限对运营者现有 `REQUEST_CODE_EMAIL_IP_RATE_MAX` 的动态回落；不新增 limiter key |
| `src/modules/auth/rate-limit-policy.test.ts`（或同模块现有测试文件） | 生效 mint 上限助手的 5 / 2 / 7 三组回落测试 |
| `src/modules/auth/magic-link.integration.test.ts` | 切片 1–4a 的真实 PostgreSQL 测试，含 admin promotion/demotion、晋升围栏（测试 26o）、事务 B task 行锁（测试 26p）、投递期消费取消（测试 26i）、intake 行锁（测试 19a）、旧 SMTP/新 active 围栏及 cleanup 引用竞态 |
| tasks dispatcher/index 对应测试文件 | post-finalization 三个入口、hook 失败/崩溃后的周期重试、final sweep 与 live/retryable 引用安全 |
| `src/modules/site/index.ts` 与 `admin-account.ts` 对应测试文件 | 晋升围栏的 fail-closed / 放行 / 取消 pending candidate / 双锁顺序断言（测试 26o 的单元侧） |
| `src/app/api/auth/magic-link/request/route.test.ts` | 切片 5 路由测试 |
| `.env.example` | 新增六个变量及注释，明确开关仅精确字符串 `true` 生效，并说明预留窗口必须覆盖 SMTP 超时预算 |
| `CHANGELOG.md` | 修正 WP1 中已过时的残余区分表述，并声明 §9.4 的行为变化 |
| `docs/handoff/issue-176-admin-magic-link-boundary.md` | 顶部加一行指针，明确 §2.2 保证 1、§3 不变量 1–2（含 request-time 时间措辞）、§4.1 请求期守卫/event 句、§5 表格、§7.1 测试 1–3 与 §10 的 supersession（仅加指针，不改写历史正文） |
| 恢复操作文档（`docs/deployment/` 下现有对应文件） | 说明恢复后预期出现一次 intake 超龄告警突发及识别方式；不修改 restore 代码 |

**明确不修改**：`src/lib/rate-limit.ts`（F8 已由持久状态断言替代）、`src/modules/tasks/enqueue.ts`、`src/modules/restore/neutralize.ts`、`src/app/api/auth/magic-link/request/route.ts`（路由逻辑不变，仅其测试新增用例）、confirm route、`session.ts`、`src/modules/user/index.ts`、`login-code.ts`、`request-code` / `verify-code` route、OAuth、i18n 文案、ADR、`docs/handoff/harden-s4-auth-rate-limiting.md`。不得再把 `deliverMagicLinkEmailTask()`、verify/consume token 查询或 token cleanup 描述为零改动；它们均在 `src/modules/auth/magic-link.ts` 的 delivery-aware 范围内。

---

## 13. 必跑门禁

### Spec PR

- `git diff --check`
- 独立只读规格复核：确认文档引用的文件、行号、函数、env 名称与默认值与 exact base `af24c6f` 一致

> 仓库 `.prettierignore` 含 `*.md`，因此 Prettier **不校验**本文件；不得声称本文件通过了 Prettier 验证。

### Implementation PR

- focused Magic Link 真实 PostgreSQL integration tests
- focused Magic Link request Route 测试
- focused tasks（queue-class / handlers / dispatcher / dead-letter 告警）测试
- focused `request-code` / `verify-code` 测试（跨流程无回归）
- `pnpm check:request-bodies`
- `pnpm check:auth-before-body`
- `pnpm format:check`
- `pnpm lint`
- `pnpm exec tsc --noEmit`
- `RUN_DB_INTEGRATION_TESTS=true pnpm test`
- `pnpm build`
- migration 验证：全新库执行 `pnpm db:migrate`；已有库升级；按 §9.3 演练回滚（含「开关关闭 → 排空 → 回滚镜像」的顺序验证）

### 浏览器 / API 验证（给出可达的临时配置）

默认配置下来源上限 20/小时、dedupe 60 s 会使证据难以在一次会话内取得。证据分成两个独立运行：A 用高 source cap 验证角色恒等、mint 上限与跨流程状态；B 重启到低 cap 后只验证来源 429。所有覆盖仅限本地/预发环境，并在 PR 中记录。

```bash
MAGIC_LINK_INTAKE_ENABLED=true
TRUSTED_PROXY_HEADER=x-forwarded-for
TRUSTED_PROXY_HOPS=1
REQUEST_CODE_RATE_WINDOW_MS=60000        # schema 允许的最小值为 10000
REQUEST_CODE_IP_RATE_MAX=30
REQUEST_CODE_SEND_DEDUPE_SECONDS=1
MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX=2
MAGIC_LINK_REQUEST_MAX_AGE_MINUTES=20    # 仅首次 claim 应用的超龄界
MAGIC_LINK_REQUEST_RETENTION_HOURS=1     # 3600000 ≥ 60000 + 1200000，满足 §5.7
```

必做条目：

1. 用 `curl -i --dump-header` 从同一 IP 对 admin、已存在 member、不存在邮箱各发一次请求：状态行、响应头集合、响应体**逐字节相同**。
2. 对同一邮箱重复请求越过 `MAGIC_LINK_MINT_EMAIL_IP_RATE_MAX=2`：全部 `200 accepted`；对 admin 邮箱同样次数结果完全相同。随后用 SQL 分别断言 `magic_link_requests where minted_at is not null` 的窗口计数不超过 2，以及对应 `magic_link_tokens` 的实际签发数不再增长，证明预算确实被跨过而不是测试根本没触达。
3. **跨流程（必须在来源桶耗尽前执行）**：从同一 IP 对同一邮箱调用 `POST /api/auth/request-code`，必须仍能正常发送；这证明 Magic Link 没有推进 `request-code-email-ip:*`（验证 G4）。
4. **独立低 cap 运行**：重启服务并仅把 `REQUEST_CODE_IP_RATE_MAX=6`，使用全新的来源 IP 连续请求；第 7 次确认返回 `429 requestRateLimited`（验证 G9）。不得复用步骤 1–3 已消耗的来源桶。
5. **默认 unresolved 复跑**：取消 `TRUSTED_PROXY_*` 覆盖（回到 `TRUSTED_PROXY_HOPS=0`），重复第 1、2 条，结果必须同样不可区分（验证 G7）。
6. **多 IP 采样**：伪造 3 个不同 `x-forwarded-for` 各发若干请求，断言三类邮箱的响应集合仍逐字节相同（验证 G8）。
7. **发布门复跑**：置 `MAGIC_LINK_INTAKE_ENABLED=false` 重复第 1 条，确认基线路径仍可正常登录（验证 §9.2 Phase 1 可用）。
8. **延迟证据（必做，但不作为 CI 门禁）**：对 admin / member / unknown 各发 ≥200 次请求，记录 p50/p90/p99，报告应显示三组分布无系统性差异。噪声使其不适合自动化断言；**结构等价的确定性证明由切片 1 测试 1 承担**。
9. 浏览器端：member 走完整登录链路（请求 → 收信 → 确认页 → 显式确认 → 进入会员页）；admin 邮箱在 UI 上得到与 member 完全一致的 accepted 提示且不产生 session。

### 评审

- 完整 diff 的 Claude Code Opus 5 只读复核（提供本规格、#175/#176/S4 handoff、base 与完整 diff）；处理 findings 后新鲜复核（AGENTS.md「独立审阅」）。
- Draft PR 上请求 `@codex review`，处理所有 actionable findings。
- 复核清单必须逐条确认：
  1. 公开请求路径不存在任何 `users` / `magic_link_tokens` / `tasks` 查询与按邮箱锁；
  2. 公开路径无角色或目标状态分支；事务内往返恒为 4 次，事务外恒为 2 次且均与目标无关（§5.2）；
  3. 任何路径都不会因角色返回非 200；
  4. 不存在目标相关的、请求者可观察的限流状态；
  5. `request-code-email-ip:*` 已在 Magic Link 全路径解除引用；
  6. mint 边界读到 admin 时 `magic_link_tokens` 与**投递任务** `auth.magic_link_email` 计数恒为 0；事务 A 读到 admin 时 0 SMTP；受理时 admin 但 mint 前已降级按 non-admin 处理，且公开路径无角色快照/抑制位（§2.2 / §2.3 / §5.3a）；
  7. 代码、注释、PR、CHANGELOG 中从未把 `auth.magic_link_request` 称为 delivery task；
  8. worker 锁顺序为 `task → magic_link_requests → advisory → token → user`，intake 行与 task 行都以 `FOR UPDATE` 锁定并持有到提交，claim 双重校验完整；清理**不在**主事务内且只删除 `resolved_at is not null` 的行，pending / processing / retryable state 不会被保留期清理；
  9. 超龄只在首次 claim 应用；第 2–5 次自动重试不因 age 被拒绝，首次超龄终态可观测；
  10. intake dead-letter 已纳入告警面；
  11. 事件/日志 payload 不超出 §5.10 白名单，且不含角色或抑制原因；
  12. `magic_link_requests` 列集合与 §5.5 完全一致（无原因列、无角色列）；
  13. `db-reset.ts` 已包含新表；
  14. 保留期跨字段 fail-closed 校验与 dedupe 告警实现在 `assertRuntimeSecurity()` 内；mint 上限回落只在 `rate-limit-policy.ts` 的纯函数助手中完成。
  15. replacement mint 只创建 pending/inactive token，绝不修改旧 active token；verify/consume 均固定 active + delivered 谓词；
  16. SMTP 在事务外；SMTP 成功后的激活事务重新检查 claim、candidate、admin role，以及 pending+active eligible replacement 的 `(created_at,id)` 单调围栏，并只 supersede 更旧 active；
  17. SMTP 失败、激活回滚、激活前崩溃与 stale lease 均保留旧 active token；激活后崩溃幂等完成且不重发；
  18. 文档与实现均未宣称 SMTP exactly-once 或旧 token 自然过期后仍保证可用；重复发送只复用同 candidate；
  19. migration/backfill 保持历史及旧代码新插入 token 可用且不延长 expiry；pending cleanup 不删除 live/retryable/人工恢复 task 引用；
  20. 切片 4a 的真实 PostgreSQL 并发、回滚、stale lease、consume race、admin promotion/demotion、migration 与 cleanup 测试均实际通过。
  21. delivery payload 以显式 `deliveryProtocol: 2` 区分 delivery-aware candidate；无 marker 的 migration 前/Phase 1 legacy task 始终走基线 SMTP，绝不走 active recovery；
  22. cleanup 锁顺序固定 task → token，与 handler 同向；legacy task 不被 v2 pending cleanup 处理。
  23. `markTaskDead`、failed-to-dead、final-attempt sweep 均在终态提交后触发 hook；周期 reconciler 覆盖 hook 失败/崩溃并最终重试，且不改变 terminal task 或执行外部副作用。
  24. 回滚 drain 会先排空可重试任务、完成 terminal-candidate reconcile，再逐项重试或安全处置 dead intake；不会因有意保留的 unresolved dead 行永久等待，也不会静默忽略、删除或伪装成功。
  25. 事务 A 与事务 B 都以 `FOR UPDATE` 持有 task 行到提交；事务 B 另以无状态过滤的 `FOR UPDATE` 锁定该邮箱全部 token 行，并在激活前检查投递预留未过期、无 `consumed_at >= candidate.created_at` 的同邮箱消费（§5.3a F-O / F-P）；
  26. `setupSite()` 与 `changeAdminEmail()` 是仓库中仅有的两条 admin 晋升写路径，二者都在既有事务内取 advisory(email)、命中未到期投递预留时 fail closed 回滚、否则取消该邮箱 pending candidate 后才写 `role`/`email`；其它 `update(users)` 调用点均未写 `role`/`email`（§5.3b）；
  27. `MAGIC_LINK_DELIVERY_RESERVATION_SECONDS` 的下界断言与 `SMTP_WORST_CASE_CALL_MS` 镜像漂移守卫均已实现；`MAGIC_LINK_INTAKE_ENABLED=true` 且 intake cap 为 0 时 `getEnv()` fail closed（§5.8）。

所有证据必须绑定 implementation exact head。未执行或因基础设施跳过的检查必须明确报告。

---

## 14. PR 顺序

1. **Spec PR（本文件）** → 独立复核通过后合并。
2. **Implementation PR**：从当时的 `main` 重新开分支（不基于本 spec 分支的代码状态），按 §10 切片提交，保持 Draft 直到全部门禁绿；不自动合并、不标记 Ready、不关闭 Issue（AGENTS.md Git 与 PR 政策）。
3. **后续 issue（实现 PR 中登记）**：下一版本把 `MAGIC_LINK_INTAKE_ENABLED` 默认值翻为 `true`、删除基线同步分支与该开关（§9.2 / §11.7）。
