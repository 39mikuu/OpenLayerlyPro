# 交接：S5 邮件投递可靠性硬化

> 自包含实现说明。前置依赖：ADR 0003 持久化任务/outbox（`enqueueTask` / dispatcher / lease / 重试 / dead-letter / 手动 `retryTask`，已在 `main`），以及 S4（#81）的 `auth.login_code_email` 投递任务 `deliverLoginCodeEmailTask`。属 v1.0 安全硬化 S5（epic #64）。**无需 ADR**——本切片只在 ADR 0003 既有骨架上加投递层语义，不改任务表契约。
>
> **前置依赖状态**：S4（#81）已于 2026-06-26 合并入 `main`，`deliverLoginCodeEmailTask`、`auth.login_code_email` 任务、`sendMail` 错误脱敏均已在 `main`；本 PR 已基于含 S4 的最新 `main` 重建，前置依赖已满足。
>
> 实现 PR 必须基于已合并 S4 的最新 `main`，保持 Draft，直到真实 PostgreSQL 集成测试与完整 CI 全绿。

## 0. 不可违反的可靠性不变量

1. **未投递的邮件绝不能被标记为 `succeeded`。** 当前 `runEmailTask` 在 SMTP 未配置时返回 `{note: "skipped"}` → 任务置 `succeeded` → 邮件永久丢失。这是本切片要消除的首要漏洞。
2. 投递失败必须落入三类之一并走对应处置：**永久失败**（立即 `dead`，不浪费重试预算）、**暂时失败**（按 ADR 0003 退避重试）、**待运维修复**（不消耗 attempts 的延迟重投，有上限年龄后转 `dead`）。默认未知错误归类为**暂时失败**（fail-open 到重试，宁可重发也不静默丢）。
3. 入队幂等已由各业务侧 `dedupeKey` 保证（`email:membership_activated:*`、`email:payment_rejected:*`、`email:membership_revoked:*`、`email:renewal_reminder:*`）。本切片**不得**移除或弱化任何既有 dedupeKey。
4. SMTP 发送本身不可幂等：投递成功后、`markSucceeded` 之前进程崩溃，lease 回收会重发——这是**已接受的 at-least-once 残余**，必须如实记录，且不得通过把发送置于成功标记之后来假装解决。
5. dead-letter 的邮件任务必须**可观测**，且必须覆盖**所有**通向 `dead` 的转移，而非只覆盖显式 `markTaskDead`。`dead` 当前有三条产生路径（见 §5）：(a) `markTaskDead`（永久/`PermanentTaskError`）；(b) `markTaskFailed` 最后一次尝试在 `markTaskFailedInternal` 内直接翻成 `dead`；(c) `claimDueTasks` 的「lease 在最终尝试后过期」回收 sweep 直接置 `dead`。三者都必须在 fenced 状态转移**成功后**对 mail 类任务落结构化 WARN。WARN 元数据仅限安全字段（`taskId`、`kind`、`attempts`、脱敏后的分类），绝不含收件人/正文/码明文。
6. 错误分类与处置对**业务邮件**（`runEmailTask`）与**登录码邮件**（`deliverLoginCodeEmailTask`）必须一致地走同一个 `classifyMailError`，但两者的"未配置"策略不同（见 §3/§4），因为登录码有短 TTL。
7. 任何日志、`lastError`、后台任务详情都不得泄露邮件正文敏感内容（登录码明文已由 S4 加密，§4 不得回退）。

## 1. 当前缺口

| 缺口 | 现状 | 后果 |
|---|---|---|
| SMTP 未配置=静默成功 | `runEmailTask`：`if (!smtp.configured) return {note:"skipped"}` | 会员开通/拒绝/续费提醒邮件永久丢失，运维事后配好 SMTP 也不补发 |
| 无瞬时/永久区分 | 所有 `sendMail` 抛错走同一通用重试 | 550 坏收件人浪费 5 次重试 ~15min 才 dead；错误信息不明确 |
| 两个 handler 策略不一致 | 业务邮件静默跳过；登录码 `sendMail` 抛 `ApiError(500,"mailNotConfigured")` → 普通重试 | 同一"未配置"两种行为，难诊断 |
| dead-letter 无主动信号 | `listTasks`/`retryTask` 存在但无计数徽标、无 dead 日志 | 自托管画师无法察觉投递已坏 |

## 2. 共享错误分类 `classifyMailError`

新增 `src/modules/mail/delivery.ts`（或 mail/index 内导出），对 nodemailer/`ApiError` 错误归一分类：

```ts
export type MailFailureKind = "permanent" | "transient" | "needs_operator";

export function classifyMailError(err: unknown): MailFailureKind {
  // 1) SMTP 未配置（ApiError mailNotConfigured）→ needs_operator
  // 2) 鉴权失败（err.code === "EAUTH"，含 535 凭据错误）→ needs_operator
  //    （凭据是运维可修复项，按"待修复"延迟重投，而非当作永久 5xx 直接 dead）
  // 3) 永久：SMTP responseCode 500–599（非 4xx）、err.code === "EENVELOPE" 且 5xx
  //    （收件人不存在、被拒、邮箱不可用）→ permanent
  // 4) 暂时：连接/超时类 ECONNECTION/ETIMEDOUT/ESOCKET/EDNS/ECONNREFUSED/ECONNRESET、
  //    responseCode 4xx（421/450/451/452 灰名单/临时）→ transient
  // 5) 其它未知错误 → transient（fail-open 到重试）
}
```

要求：
- 分类**只看错误形状**，不靠字符串模糊匹配业务文案。
- `EAUTH` 必须落 `needs_operator` 而非 `permanent`：凭据过期是最常见的可恢复故障，直接 dead 会丢邮件。
- 单测覆盖每一类至少一个代表样本（构造带 `responseCode`/`code` 的假错误）。

> **与 S4(#81) B3 的衔接（必读）**：#81 已让 `sendMail` 在 catch 内把 nodemailer 原始错误替换为通用 `Error("SMTP delivery failed")`，以防 envelope/响应文本/正文（含登录码）经 task `lastError`/后台任务面板泄露。因此原始的 `responseCode`/`code` **不会逃出 `sendMail`**，调用方拿不到结构化错误，无法事后分类。S5 必须把分类**放进 `sendMail` 的 catch 内部**对原始错误执行，并只向外抛出「已分类但脱敏」的错误——例如自定义错误类携带 `kind: MailFailureKind` 字段、`message` 仍为安全的通用文案，绝不携带原始 transport 对象/响应文本/收件人/正文。`runEmailTask` 与 `deliverLoginCodeEmailTask` 据该 `kind` 决定 permanent/transient/needs_operator 处置，而非重新解析错误字符串。

## 3. 业务邮件投递策略（`runEmailTask`）

业务邮件（会员/支付/续费）无短 TTL，运维稍后修好 SMTP 仍应补发。改写处置：

1. **删除静默跳过分支**。不再有"未配置→succeeded"。
2. 调 `sendMail` 抛错后按 `classifyMailError`：
   - `permanent` → 抛 `PermanentTaskError(简明原因)` → dispatcher 置 `dead`，不浪费重试。
   - `transient` → 抛普通 `Error` → ADR 0003 退避重试（1/2/4/8min，第 5 次 dead）。
   - `needs_operator`（未配置 / EAUTH）→ **返回 `{deferUntil}`**，复用 dispatcher 既有 defer 路径（`deferTask` 会 `attempts = greatest(attempts-1,0)` 且置回 `pending`，**不消耗重试预算**），`deferUntil = now + EMAIL_RETRY_RECHECK_MINUTES`。运维配好 SMTP 后下个 recheck 自动补发。
3. **年龄上限兜底**：在返回 defer 前检查 `task.createdAt`。若任务已存在超过 `EMAIL_DELIVERY_MAX_AGE_HOURS`，不再 defer，改抛 `PermanentTaskError("SMTP unavailable; email expired after N h")` → dead（可后台手动重试）。避免未配置时无限延迟堆积。

> defer 不消耗 attempts，所以这条邮件会在 `[recheck, 2×recheck, …]` 节奏一直待命直到 SMTP 可用或超 `MAX_AGE`，与 `subscription.reconcile` 复用同一机制。投递重试/defer 骨架本身不改；唯一的 dispatcher/终结改动来自 §5 的 dead-letter 可观测性（终结 API 需返回结果状态以便正确 WARN），且无 schema 迁移。

## 4. 登录码邮件投递策略（`deliverLoginCodeEmailTask`，短 TTL）

登录码 TTL 仅约 10 分钟，过期后 deliver 任务本就 no-op 跳过（S4 已实现 used/expired/superseded skip，§7 不得回退）。因此**不做 defer**（延迟到 SMTP 修好时码早已过期，徒增噪声）：

1. 现有 `sendLoginCodeEmail` 抛错处用 `classifyMailError`：
   - `permanent` → `PermanentTaskError` → dead（用户会自行重新请求码）。
   - `needs_operator`（未配置 / EAUTH）→ 同样 `PermanentTaskError("SMTP unavailable for login code")` → dead。在 TTL 内延迟重投无意义，快速失败 + 用户重试更顺。
   - `transient` → 抛普通 `Error` → 退避重试；TTL 内若仍未发出，过期后 deliver 自然跳过为 success no-op。
2. **登录码 dead-letter 必须落 WARN 日志**（仅含 `taskId`/`codeId`/分类，**不含邮箱、不含码明文**），让运维能察觉登录通道故障。

## 5. dead-letter 可观测性

最小且与单画师自托管画像匹配，不引入外部告警组件。**注意：无需 schema 迁移，但需要一处小的任务终结/dispatcher 改动**——因此 PR 不应再声称「dispatcher 零改动」。

1. **任意 dead 转移都落结构化 WARN**（覆盖 §0-5 列出的三条路径）：
   - 关键障碍：`markTaskFailed`/`markTaskDead`/claim-sweep 目前只返回 `boolean`，调用方无法区分这次终结到底落到 `failed` 还是 `dead`，因此无法只在「转成 dead」时 WARN。
   - 要求：让终结 API 返回结果状态（如 `{ updated: boolean; status: "failed" | "dead" }`），或以等价方式在 fenced 转移内部就地判定，**不得**在转移后再做一次「不安全的二次猜测查询」。
   - 只有在 fenced 状态转移**成功**后才 `logger.warn("email task dead-lettered", { taskId, kind, attempts, classification })`（`classification` 为脱敏后的分类，不含原始错误对象/响应文本/收件人/正文/码明文）。
   - 三条路径都要接线：`markTaskDead`、`markTaskFailed` 最终尝试翻 dead、`claimDueTasks` 的 lease-过期-sweep 翻 dead。
2. **后台任务计数用专门聚合查询，不靠分页行计数**：
   - 现有 `listTasks` 上限 200 行、无 `kind` 过滤、无分组计数；对其返回行做计数会在任务数 >200 时静默少计，也给不出「仅邮件类」的准确徽标。
   - 要求：新增专门聚合查询（按 `status` 分组的 `COUNT(*) FILTER (...)`，并可按 mail-kind 家族 `email` / `auth.login_code_email` 过滤），或显式扩展后台 API 返回精确计数；徽标只用聚合结果，不用受限/分页的任务行。手动 `retryTask` 已可用。
3. **不**在 `/api/ready` 加 dead-task COUNT：readiness 每请求执行，加 COUNT 会给探活路径上 DB 压力；投递健康属运营观测而非就绪门禁。（如 owner 坚持，可改为带缓存 TTL 的独立 `/api/admin/delivery-health`。）

## 6. at-least-once 重复（已接受残余）

- SMTP 发送不可幂等。发送成功后、`markSucceeded` 前崩溃，lease 回收重投会重发。dedupeKey 只防**重复入队**，不防**重复投递**。
- 处置：**接受并记录**。重复通知类邮件无害；重复登录码已被 deliver 的 used/superseded skip 削弱（旧码若已被用或被新码取代则跳过）。
- 不得为掩盖此残余把"发送"挪到成功标记之后或引入伪幂等。文档（部署文档 + 本交接）写明此残余即可。

## 7. 环境变量

```
EMAIL_RETRY_RECHECK_MINUTES   int  min 1   max 1440   default 15
EMAIL_DELIVERY_MAX_AGE_HOURS  int  min 1   max 168    default 24
```

- `EMAIL_RETRY_RECHECK_MINUTES`：`needs_operator` 业务邮件的延迟重投间隔。
- `EMAIL_DELIVERY_MAX_AGE_HOURS`：业务邮件最长待命窗口，超时转 dead。
- 登录码不读这两个值（§4 不 defer）。

## 8. 测试要求（真实 PostgreSQL，`RUN_DB_INTEGRATION_TESTS=true`）

- `classifyMailError` 单测：permanent(5xx/EENVELOPE)、transient(超时/4xx/未知)、needs_operator(未配置/EAUTH) 各至少一例。
- `runEmailTask`：未配置 → 返回 `deferUntil`（不再 succeeded）；超 `MAX_AGE` → `PermanentTaskError`/dead；永久错误 → dead 不重试；瞬时错误 → failed 并退避。
- `deliverLoginCodeEmailTask`：未配置/永久 → dead；瞬时 → 重试；过期后 → success no-op；dead 路径不泄露邮箱/码明文。
- dispatcher：defer 路径不消耗 attempts（已有测试，确认未回退）。
- **dead-letter WARN 覆盖三条路径**：(a) `PermanentTaskError`/`markTaskDead`、(b) `markTaskFailed` 最终尝试翻 dead、(c) lease-过期-sweep 翻 dead，三者都断言对 mail 类任务落了 WARN，且 WARN 不含收件人/正文/码明文；非 dead 终结（如 `failed` 退避）不得误报 WARN。
- **聚合计数**：构造 >200 条任务（含若干 failed/dead 的 mail 类），断言聚合查询给出准确的按 status / mail-kind 家族计数，而分页 `listTasks` 行计数会少计（证明不能用行计数）。
- 回归：所有既有 email dedupeKey 仍存在且行为不变。

## 9. 验证命令

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm exec drizzle-kit generate   # 预期无新迁移（不改任务表）
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

本切片**不应**产生 schema 迁移；若 drizzle-kit 生成了迁移，说明误改了任务表契约，需复核。

## 10. 验收 checklist

- [ ] 未配置 SMTP 的邮件不再被标记 succeeded
- [ ] `classifyMailError` 三类齐全，EAUTH 归 needs_operator 而非 permanent，未知归 transient
- [ ] 业务邮件：permanent→dead、transient→退避、needs_operator→defer 不耗预算、超龄→dead
- [ ] 登录码邮件：permanent/needs_operator→dead、transient→重试、过期→success no-op
- [ ] 登录码 dead/日志不含邮箱与码明文
- [ ] dead-letter WARN 覆盖全部三条 dead 转移（markTaskDead / markTaskFailed 终尝试 / lease-sweep），终结 API 返回结果状态以便只在转成 dead 时 WARN，非 dead 终结不误报
- [ ] 后台 failed/dead 计数用专门聚合查询（按 status/mail-kind 家族），不靠分页 listTasks 行计数；可手动重试
- [ ] 所有既有 email dedupeKey 未被移除或弱化
- [ ] at-least-once 重复残余已在部署文档记录
- [ ] 无新 schema 迁移（dead-letter 可观测仅需小的终结/dispatcher 改动，非 schema）
- [x] #81(S4) 已合并且本 PR 已基于含 S4 的最新 main 重建（CI 重跑见本 PR）
- [ ] 真实 PostgreSQL 测试与完整 CI 全绿

## 已锁定决策（owner 待确认）

- 错误分类三分：permanent（5xx/坏收件人，立即 dead）/ transient（连接超时/4xx/未知，退避重试）/ needs_operator（未配置/EAUTH，延迟重投不耗预算）。
- 业务邮件 needs_operator 默认每 **15 分钟**重投，最长 **24 小时**后转 dead。
- 登录码邮件 needs_operator/permanent 一律快速 dead，不 defer（TTL 内无意义）。
- dead-letter 可观测=结构化 WARN 日志（覆盖全部三条 dead 转移）+ 后台聚合计数徽标（专门 COUNT 查询，非分页行计数）；**不**在 `/api/ready` 加 COUNT。
- at-least-once 重复投递为已接受残余，仅文档化，不引入伪幂等。
- 本切片无 schema 变更；但 dead-letter 可观测需要一处小的任务终结/dispatcher 改动（终结 API 返回结果状态），故不再声称「dispatcher 零改动」。
- 合并顺序：#81(S4) 已先行合并；本 PR 已基于含 S4 的最新 main 重建并重跑 CI。
