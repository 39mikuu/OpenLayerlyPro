# ADR 0009：周期性会员（订阅自动续费 + 手动周期提醒）

- **Status**：Accepted ✅（2026-06-21；三轮评审锁定后接受）
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

### 4. Stripe 映射：实际周期 + 合同快照 + 下单并发安全 + 可恢复锚点

- tier 增 `stripe_price_id`（预建 recurring Price）;「可订阅」由其是否存在判定。
- **价格合同快照(B4)**:`subscriptions` 在创建时**快照** `provider_price_ref`、`expected_amount_minor`、`expected_currency`(必要时 quantity)。Checkout 用快照;**续费 invoice 按订阅快照校验,不按可变的 tier 设置**。改 tier 价格只影响**新**订阅;把存量订阅迁到新 Price 是显式的后续操作。
- **invoice 行选取**:按**匹配该订阅 item / 快照 `provider_price_ref`** 的行取 period/amount;**不取任意 `invoice.lines[0]`**;不存在恰好一条受支持周期行 → 拒绝并告警。
- **下单并发安全(B2,对齐一次性 checkout)**:
  - **每 `(user_id, tier_id, provider)` 至多一个非终态订阅**:部分唯一约束 +(必要时)事务 advisory lock。
  - checkout 创建用 claim token + lease/stale 恢复;**稳定 Stripe 幂等键 `subscription-checkout:<localSubscriptionId>`**。
  - 已有 open Checkout → **返回既有 URL**,不再建;已有 active/past_due 订阅 → 拒绝新建。
  - **Stripe 建会话成功但本地 ref 持久化崩溃 → 可恢复**(claim/lease + 对账,见 §8)。
- **可恢复锚点(B3)**:`subscriptions` 持久化 `provider_checkout_ref`(Checkout Session id;建会话后**条件写入**)、可选 `provider_customer_ref`。即便 `checkout.session.completed`/`subscription.created`/`invoice.paid` 全丢,对账也能由 session → `session.subscription` → subscription/invoices 恢复(见 §8)。
- **顺序无关**：Checkout 前先建本地 `subscription(status='pending')` + 本地 id 写入 Stripe metadata;`invoice.paid` 按 metadata/ref **upsert 恢复**,不要求 `subscription.created` 先到;owned-but-unresolved **可重试/落库**,绝不永久 no-op。

### 5. 持久化 inbox + 内部 dispatcher（B5;复用 ADR 0003 outbox/lease/fencing）

**webhook ACK 与业务处理解耦**——避免「认领失败方返回 200 但认领者崩溃 → Stripe 视为已送达不再重试 → 事件丢失」。采用**持久化 inbox(= 事件账本)+ 内部 dispatcher**(Option A):

```
payment_provider_events(   -- inbox
  id, provider, provider_event_id, event_type, object_ref,
  provider_created_at timestamptz,
  payload_json jsonb,                          -- 归一化后的事件载荷（dispatcher 据此执行，无需回查）
  status text: received | processing | processed | failed | dead,
  locked_by text NULL, lease_until timestamptz NULL,
  attempts int default 0, max_attempts int,
  processed_at NULL, error NULL, created_at
)
-- UNIQUE(provider, provider_event_id)
```

- **webhook 路由只做两件事**:验签 → 把**归一化 payload 持久化进 inbox**(`ON CONFLICT(provider,event_id) DO NOTHING`)→ **返回 200**。**返回 200 = 已取得持久化所有权**(不是"已处理");此后丢的不再是 Stripe 的事,由 dispatcher 兜。
- **内部 dispatcher**(复用 ADR 0003 task 范式):`received/failed → processing` 条件更新 + 随机 `locked_by` + `lease_until`;**只有认领者执行**;超 `max_attempts` → `dead`(后台可见可手动重试);`processing` 过 lease 由 stale 回收。
- **严格原子(碰钱,非"尽量")**:业务变更 + 审计/outbox + `processed`(带 token fencing 校验)**必须同一 DB 事务**提交;**最终 fencing 校验失败 → 整个业务事务回滚**(旧认领者 token 失效则其全部业务变更不落地)。
- **幂等**:inbox `UNIQUE(provider,event_id)` 去重投递 + §6 对象级 `provider_invoice_ref` 去重财务对象,双层。
- **乱序/冲突**:subscription **聚合状态**转移按 `provider_created_at`(单调)拒绝过期事件;**时间相等或跨 Stripe 对象冲突 → 以权威 Stripe 读为准**(reconcile)。**invoice 权益**始终对象级(按 invoice),不受聚合状态影响。

### 6. 续费 = 按笔建行 + 对象级幂等 + 续费 reversal-first（B1）

- **付款对象级身份**:`payment_requests` 增 `provider_invoice_ref`,**部分** `UNIQUE(provider, provider_invoice_ref)`。**event id 去重「投递」,invoice id 去重「财务对象/授予」**。
- **统一入口 `applyPaidInvoice(invoiceId, ...)`**:webhook 与 reconcile **走同一路径**。用 `INSERT ... ON CONFLICT(provider,provider_invoice_ref) DO NOTHING RETURNING`(**不**在同事务内 catch 唯一冲突——那会让事务 abort):
  - 插入成功(无既有行)→ 该 invoice 未被反转 → `grantMembershipForPeriod(period)` + 更新 subscription `current_period_ends_at`(按事件时间防乱序)+ 审计 + 续费邮件。
  - 冲突(已有行)→ 视其 `status`:`approved` = 已处理,幂等 no-op;**`reversed`(反转墓碑)= 不授予**(B1)。
- **续费 reversal-first 墓碑(B1)**:订阅未来 invoice 在 `invoice.paid` 前**没有**本地 payment_request,故 `charge.refunded`/`charge.dispute.created` 先到时:
  - **把 refund/dispute 解析到关联 invoice id**(不只 PaymentIntent;Stripe charge→invoice)。
  - **在任何 grant 之前**持久化一行 `payment_request(status='reversed', provider_invoice_ref=该invoice, subscription_id, reversal_event_id)` 作为墓碑(同样 `ON CONFLICT DO NOTHING`)。
  - 之后 `applyPaidInvoice` 命中该墓碑 → **不授予**;后到的 paid 事件可补齐缺失引用(provider_payment_ref 等),但**不得**开通权益。
- **按 invoice 决策**:只看该 invoice 自身是否被反转;**不**因 subscription 聚合 `canceled` 否决一笔已付 invoice。
- **grant 已存在时的退款/拒付**:复用 #49,按唯一 `granted_membership_id` 吊销**那一行**(目标发现 + 反转动作沿用,仅扩展到「按 invoice 找 grant」)。
- **reconcile 造的 payment_request**:`provider_event_id` 允许为空或用**单独的 reconciliation causation 字段**;**不要伪造 Stripe event id**。

### 7. 手动周期提醒（无卡地区）

`provider=NULL` 订阅 + durable task `subscription.renewal_reminder`（到期前 N 天,默认 7,可配,有上下限）→ 提醒邮件 → 粉丝走现有人工/一次性入会再付一期（`grantMembership`,`durationDays`）→ 重排。

### 8. 对账安全网（webhook 不可靠的兜底 + 对象级幂等）

webhook 不保证送达。两层保证:

- **结构性 fail-safe**:订阅行 `endsAt = 已付 period.end`。漏掉失败/取消回调 → 会员**不超期**,在最后已付周期末自然到期。`past_due` 仅状态标,不延长权益;**不加 Core 宽限窗口**。
- **`subscription.reconcile` durable task**:拉 Stripe 权威状态,经**同一 `applyPaidInvoice(invoiceId)` 路径**补齐漏掉的续费;**对象级幂等靠 `UNIQUE(provider_invoice_ref)`**——即使原 `invoice.paid` 事件随后才到,event-id 与 invoice-id 双重去重保证同一期只授予一次。
  - **覆盖状态集**(不止 active/past_due):`pending`(activation 与 paid 都丢)、**近期** `canceled/expired`(可能仍缺某期已付 invoice)、**未解析的 provider-ref 恢复记录**;终态订阅仅在**文档化的 invoice 回溯/保留窗口**之后停止对账。
  - **pending 的恢复锚点**:pending 行无 `provider_subscription_ref`,但有 `provider_checkout_ref`(§4)。reconcile 对 pending **先 `checkout.sessions.retrieve`** → 取 `session.subscription` → 再 `subscriptions.retrieve` + `invoices.list`。**过期/放弃的 session**(`expired`/未支付)→ 把**永久 incomplete** 的 pending 行转**终态**(`expired`),停止对账。
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
- **续费 reversal-first**:`refund/dispute` **早于** `invoice.paid`(无本地 request)→ 墓碑先落,后到 paid **不授予**。
- **下单并发**:并发 double-click subscribe → **只产生一个** Stripe 订阅;已有 open checkout 返回既有 URL;已有 active/past_due 拒绝新建。
- **建会话成功、本地保存崩溃** → 重试/对账**恢复同一会话**,不重复建订阅。
- **pending 全丢**(checkout.completed/subscription.created/invoice.paid 都丢)→ reconcile 经 `provider_checkout_ref` 恢复;过期 session → pending 转终态。
- **改 tier 价后老订阅续费**:按订阅**快照**校验仍成功(B4)。
- **inbox/dispatcher**:认领失败方返回(claimant 崩溃)→ dispatcher 仍**恰好处理一次**;stale 认领者丢 fencing → 其业务变更**整体回滚**。
