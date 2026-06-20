# ADR 0009：周期性会员（订阅自动续费 + 手动周期提醒）

- **Status**：Proposed ▶（2026-06-20；评审中,模型锁定后转 Accepted）
- **相关 issue**：v1.0 会员续费（待建 issue）
- **依赖**：[ADR 0001](0001-membership-lifecycle-model.md)（会员生命周期）、[ADR 0002](0002-audit-and-event-strategy.md)（审计 + 因果链）、[ADR 0003](0003-durable-task-and-outbox-boundary.md)（durable tasks / outbox / fencing）、[ADR 0005](0005-auto-payments.md)（自动收付款 + 可插拔 provider）

## Context

会员入会现有两条**一次性**路径:人工审核（v0.1）、一次性自动（v0.2，Stripe `mode=payment`）。缺口:**没有经常性会员**。owner 决策:① 三种入会并存;② 首版 = Stripe Subscriptions + 手动周期提醒,留 provider 扩展性。

**现有会员模型（已核对代码,前稿曾描述错误,此处更正）**:`grantMembership`（`src/modules/membership/index.ts`）**每次授予 INSERT 一个新的 `memberships` 行**,用 `startsAt` 调度（同/低 tier 且当前 active → `startsAt = 当前 active.endsAt` 顺排,否则 `now`）,`endsAt = startsAt + duration`;`payment_requests.granted_membership_id` **唯一**;`getActiveMembership` 取 `startsAt<=now<endsAt` 且 active 中 **tier 最高** 的行;反转（#49）按 `granted_membership_id` 吊销**那一行**,不影响其他行。**即现有 `memberships` 本身已是「按笔账本」**。

评审（PR #59 两轮）的硬约束:按期反转正确、webhook 顺序无关、用 Stripe 实际周期、事件幂等 + 防乱序 + **并发认领/fencing**、按 invoice 决策、**对账有对象级幂等身份**。

## Decision

### 1. 复用现有 `memberships` 作为按笔账本（不新增事实表、不迁移、不 supersede 0001）

订阅续费**复用现有 `memberships` 按笔模型**——**每一笔已付 invoice = 一个 `memberships` 行**:

- `source='payment_auto'`,`startsAt = invoice 行 period.start`、`endsAt = invoice 行 period.end`（**Stripe 权威周期**;**不用固定 `durationDays`、不以 `now` 为锚**）。
- **反转 = 吊销那一行**（复用现有 `revokeMembership` / #49,按唯一 `granted_membership_id`）:只撤对应那一期,天然保留其他期 / 手动 / 一次性。
- **有效会员 = 现有 `getActiveMembership`**（`startsAt<=now<endsAt` 且 active 的最高 tier 行）——**确定性投影**,纯由「行集合 + now」决定,不依赖执行时刻。
- 反转中间一期会留下**空洞**——这是**正确语义**(那期退款了);**不**填洞顺延(填洞会让权益超过已付边界,违反 fail-safe)。

> **不引入第二张 `membership_grants` 表、不回填迁移现有 memberships、不 supersede ADR 0001。** 本切片是给现有按笔模型**新增一条「按 Stripe 周期建行」的授予路径**,现有人工 / 一次性 / 反转(#49)语义与代码**不变**(大幅降低回归面)。

### 2. 新增「按指定周期授予」路径（不复用 now 锚定）

现有 `grantMembership` 对同/低 tier 会把 `startsAt` 重锚到 `current.endsAt`;订阅**不能**这样(要用 Stripe 周期)。新增 `grantMembershipForPeriod({userId,tierId,source,startsAt,endsAt,paymentRequestId,...}, tx)`:**逐字写入 Stripe period,不重锚 now/current**。手动提醒(无 Stripe 周期)走现有 `grantMembership`(`durationDays`)。

- **确定性 + 不超界**:订阅行 `endsAt === invoice period.end`,任何时刻投影一致,且**永不超过已付边界**。
- **跨 tier 调度**:沿用 `getActiveMembership`(按 tier level 选当前覆盖行);订阅周期可能与既有手动/高 tier 行重叠 → 重叠期取最高 tier(正确,无损失);订阅行始终只覆盖其已付 Stripe 周期。

### 3. provider 无关 `subscriptions` 表 + 可选 recurring 能力

新增 `subscriptions`（provider 无关,记录续费意图/状态/取消;`provider=NULL` = 手动提醒）。`PaymentProvider` 加**可选** `createSubscriptionCheckout?`/`cancelSubscription?` + `subscription_*` 归一化事件（带 invoice period、provider 事件 id、**provider 事件时间**）。仅 Stripe 实现,其他 provider 留接口。（表/字段见 handoff。）

### 4. Stripe 映射：实际周期 + 顺序无关 + 正确行选取

- tier 增 `stripe_price_id`（预建 recurring Price）;「可订阅」由其是否存在判定。
- **invoice 行选取**:按**匹配该订阅 item / `stripe_price_id`** 的行取 period/amount;**不取任意 `invoice.lines[0]`**;不存在恰好一条受支持的周期行 → 拒绝并告警。
- **顺序无关**(B2 前轮)：Checkout 前先建本地 `subscription(status='pending')` + 本地 id 写入 Stripe metadata;`invoice.paid` 按 metadata/ref **upsert 恢复**,不要求 `subscription.created` 先到;owned-but-unresolved **可重试/落库**,绝不永久 no-op。

### 5. 事件账本 + 原子认领/fencing + 防乱序（复用 ADR 0003 fencing）

新增 `payment_provider_events`（**所有** provider 事件）。仅 `received|processed|failed` 不足以防并发重复执行——**复用 durable task 的认领/fencing 范式**:

```
payment_provider_events(
  id, provider, provider_event_id, event_type, object_ref,
  provider_created_at timestamptz,
  status text: received | processing | processed | failed,
  locked_by text NULL, locked_at timestamptz NULL, attempts int default 0,
  processed_at NULL, error NULL, created_at
)
-- UNIQUE(provider, provider_event_id)
```

- **认领**:`received/failed → processing` 用**条件更新 + 随机 claim token(`locked_by`)**;**只有认领成功者**执行业务;业务变更 + 审计/outbox + 置 `processed` **尽量同事务原子**提交。
- **fencing**:旧 worker 因 token 不匹配**无法**在新认领者之后完成。
- **stale 恢复**:`processing` 超时可被回收(同 outbox lease)。
- **failed 可重试**;**幂等**:`UNIQUE(provider,event_id)` + 业务侧对象级唯一(§6)双层。
- **乱序/冲突策略**:subscription **聚合状态**转移用 `provider_created_at`(单调)拒绝过期事件;**时间相等或来自不同 Stripe 对象冲突时**,以**权威 Stripe 读取**为准(reconcile 拉取)。**invoice 权益**始终对象级(按 invoice),不受聚合状态影响(B5 前轮)。

### 6. 续费 = 按笔建行 + 对象级幂等（invoice 身份）

- **付款对象级身份**:`payment_requests` 增 `provider_invoice_ref`,`UNIQUE(provider, provider_invoice_ref)`。**event id 去重「投递」,invoice id 去重「财务对象/授予」**。
- **统一入口 `applyPaidInvoice(invoiceId, ...)`**:webhook 与 reconcile **走同一路径**;事务内:`payment_request(approved, subscription_id, provider_invoice_ref, provider_event_id, amount/currency)` + `grantMembershipForPeriod(period=invoice period)` + 更新 subscription `current_period_ends_at`(按事件时间防乱序)+ 审计 + 续费邮件。`UNIQUE(provider_invoice_ref)` 保证 webhook 与 reconcile **不重复授予同一期**。
- **按 invoice 决策**:只看该 invoice 自身是否被退款/拒付/反转;**不**因 subscription 聚合 `canceled` 否决一笔已付 invoice。
- **退款/拒付**:复用 #49,按 `granted_membership_id` 吊销**那一行**。

### 7. 手动周期提醒（无卡地区）

`provider=NULL` 订阅 + durable task `subscription.renewal_reminder`（到期前 N 天,默认 7,可配,有上下限）→ 提醒邮件 → 粉丝走现有人工/一次性入会再付一期（`grantMembership`,`durationDays`）→ 重排。

### 8. 对账安全网（webhook 不可靠的兜底 + 对象级幂等）

webhook 不保证送达。两层保证:

- **结构性 fail-safe**:订阅行 `endsAt = 已付 period.end`。漏掉失败/取消回调 → 会员**不超期**,在最后已付周期末自然到期。`past_due` 仅状态标,不延长权益;**不加 Core 宽限窗口**。
- **`subscription.reconcile` durable task**:拉 Stripe 权威状态,经**同一 `applyPaidInvoice(invoiceId)` 路径**补齐漏掉的续费;**对象级幂等靠 `UNIQUE(provider_invoice_ref)`**——即使原 `invoice.paid` 事件随后才到,event-id 与 invoice-id 双重去重保证同一期只授予一次。
  - **覆盖状态集**(不止 active/past_due):`pending`(activation 与 paid 都丢)、**近期** `canceled/expired`(可能仍缺某期已付 invoice)、**未解析的 provider-ref 恢复记录**;终态订阅仅在**文档化的 invoice 回溯/保留窗口**之后停止对账。
- handler 失败返回非 2xx → Stripe 重试;事件账本 `failed` 可重处理。

### 9. 三来源并存 + UI

人工/一次性/订阅都进 `memberships` 按笔账本,`getActiveMembership` 统一。tier `purchase_enabled` 控一次性、`stripe_price_id` 控订阅。`me`/后台:订阅状态 + 取消（默认 `cancel_at_period_end`）。

## Alternatives

- **新增 `membership_grants` 第二事实表 + 派生投影 + 迁移现有 memberships**:否决。基于「memberships 是单行可变」的**错误前提**;现有 `memberships` 已是按笔账本,复用它**零迁移、零 supersede、零回归面**。
- **续费按固定 `durationDays`**:否决——与 Stripe 实际周期漂移。
- **以 `now` 为锚重算投影**:否决——非确定性,且可能超过已付边界。
- **事件账本仅 received/processed/failed**:否决——并发重复执行;需认领/fencing。
- **reconcile 仅靠 event id 幂等**:否决——reconcile 发现的是 invoice 对象;需 `provider_invoice_ref` 对象级身份。
- **按 subscription 聚合状态决定开通**:否决——乱序下收钱不给权益。

## Consequences

- ✅ 真正续费(Stripe 自动 + 无卡半自动),1.0 闭环补齐;**复用现有按笔会员模型 → 无数据迁移、不改现有 grant/反转语义、回归面小**。
- ✅ 确定性投影 + 订阅权益严格 = 已付 Stripe 周期(永不超界);退款只撤对应行。
- ✅ 事件认领/fencing + invoice 对象级幂等 → 并发/乱序/重投递/对账-竞争 webhook 安全。
- ⚠️ schema 迁移：新增 `subscriptions`、`payment_provider_events`;`payment_requests` 加 `subscription_id` + `provider_invoice_ref`(+ 唯一);`membership_tiers.stripe_price_id`。**无需迁移现有 memberships**。
- ⚠️ 新增 `grantMembershipForPeriod`（不重锚）;须测试与现有重锚行为、跨 tier、并存共处。
- ⚠️ Stripe 事件集扩大 + 认领/fencing + 对账状态集 + invoice 行精确选取,需充分测试。
- ⚠️ 手动提醒依赖 task 调度 + 邮件送达。

## 已定（owner,2026-06-20）

1. 模型 = **复用现有 `memberships` 按笔账本**(option 1),每笔已付 invoice 一行、用 Stripe 实际周期、反转吊销那一行;**不**新增 `membership_grants`、**不**迁移、**不** supersede 0001。
2. 反转中间一期**留空洞**(正确语义),不填洞顺延。
3. 取消默认 = `cancel_at_period_end`。
4. dunning = Stripe + 对账(§8)+ 权益按已付 period.end 结构性 fail-safe;不加 Core 宽限窗口。
5. 「可订阅」判定 = `stripe_price_id` 是否存在;手动提醒提前 7 天(可配)。

## 必须覆盖的测试

- 同一 ledger 在**不同系统时间**投影一致(确定性);订阅权益**不超过已付 invoice 边界**(不变量)。
- 高 tier active + 低 tier 购买(跨 tier 调度);中间一期反转(跨 tier);并存手动/一次性时按笔反转只撤对应行。
- `invoice.paid` 早于 `subscription.created`;`subscription.deleted` 早于已付 invoice;`failed→paid→旧 failed 重放` 不回退。
- **并发同一 webhook 两次** → 仅认领者执行一次(fencing);stale processing 可恢复;旧 worker token 失效无法完成。
- reconcile：late webhook 之前 reconcile、pending 全丢、canceled-before-missing-paid、并发 reconcile、reconcile 与 webhook **竞争同一 invoice** → `UNIQUE(provider_invoice_ref)` 保证仅一次授予。
- invoice 多行/无受支持周期行 → 拒绝告警,不取任意首行。
- 月末/2 月·闰年/非默认 anchor → 周期取 Stripe 实际值。
- 金额校验、reversal-first、不碰卡号、非 Stripe provider 优雅降级。
