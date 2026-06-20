# 交接：周期性会员 — Stripe 自动续费 + 手动周期提醒

> 给执行 agent 的自包含实现说明。前置依赖:当前 `main`(已含 v0.2 自动支付 / Stripe 一次性 / 退款·拒付反转、durable tasks + fencing、会员生命周期)。落地决策见 [ADR 0009](../adr/0009-recurring-subscriptions.md)。
>
> 开工前建 issue;PR 保持 Draft,直到真实 PG 集成测试 + 完整 CI 全绿。
>
> **建议分两个 PR 串行**:**PR-A** = Stripe 自动续费(按笔建行 + 事件账本 + 对账);**PR-B** = 手动周期提醒。本文件覆盖两者,§标注所属 PR。
>
> ⚠️ **关键前提(已核对代码)**:现有 `memberships` **每次授予 INSERT 一行**(`startsAt` 调度、`granted_membership_id` 唯一、反转吊销那一行)——**本身已是按笔账本**。本切片**复用它**,**不新增 `membership_grants`、不迁移现有数据、不改现有 grant/反转语义**;只**新增「按 Stripe 周期建行」的授予路径**。

## 0. 红线

1. **绝不接触卡号 / 敏感数据**;验签密钥不入日志/审计。
2. **订阅权益 = 已付 invoice 周期**:订阅 `memberships` 行 `startsAt=invoice.period.start`、`endsAt=invoice.period.end`;**不用 `durationDays`、不以 now 为锚**;**永不超过已付边界**。
3. **按笔反转**:退款/拒付按唯一 `granted_membership_id` 吊销那一行,只撤对应期;反转中间期**留空洞**(正确),不填洞。
4. **webhook 顺序无关**;owned-but-unresolved **可重试/落库**,不当永久 no-op。
5. **事件原子认领 + fencing**:并发同一事件只执行一次;旧 worker token 失效不可完成。
6. **对象级幂等**:`UNIQUE(provider, provider_invoice_ref)`;webhook 与 reconcile 走**同一** `applyPaidInvoice(invoiceId)`,同一期只授予一次。
7. **按 invoice 决策**,不按 subscription 聚合状态;金额校验;不破坏现有人工/一次性/#49 回归。

## 1. 现状（必读,直接扩展别重写）

- **会员**`src/modules/membership/index.ts`:`grantMembership` **INSERT 新行**(同/低 tier active → `startsAt=current.endsAt` 重锚,否则 now;`endsAt=startsAt+duration`);`getActiveMembership`(`startsAt<=now<endsAt` 且 active 最高 tier);`revokeMembership(id,...)` 吊销那一行;`source` 含 `payment_auto`。
- **支付**`src/modules/payment/index.ts`:`confirmAutoPayment`/`reverseAutoPayment`/`applyApprovedPaymentReversal`(#49,按 `granted_membership_id` revoke 那一行——**已是按笔反转,无需改**)。
- **provider 抽象**`providers/index.ts`:`PaymentProvider` + `NormalizedPaymentEvent`;`getPaymentProvider('stripe')`。Stripe 适配器 `providers/stripe.ts`。
- **webhook**`src/app/api/payments/webhook/stripe/route.ts`:raw body 验签 → parse → 幂等。
- **durable tasks + fencing**`src/modules/tasks/`:`enqueueTask`;**lease + claim fencing 范式**(复用到事件认领,见 §5);`tasks.kind` 无约束 text。
- **schema**:`membershipTiers`(`priceAmountMinor`/`currency`/`durationDays`/`purchaseEnabled`);`paymentRequests`(status/flow/provider*/amount/currency/`grantedMembershipId` 唯一/`providerEventId`);`memberships`(source/startsAt/endsAt/status/version);`payment_requests.granted_membership_id` 唯一。
- 邮件 `src/modules/mail/` 按 `users.locale`;配置中心 `getStripeConfig()`。

## 2. 锁定决策（见 ADR 0009）

| # | 决策 |
|---|---|
| D1 | **复用 `memberships` 按笔账本**:每笔已付 invoice = 一行,Stripe 实际周期;反转吊销那一行。**不新增事实表、不迁移、不 supersede 0001。** |
| D2 | 新增 `grantMembershipForPeriod`(逐字写 Stripe period,不重锚);手动提醒走现有 `grantMembership`(durationDays)。 |
| D3 | provider 无关 `subscriptions` 表(状态含 `pending`);`PaymentProvider` 加可选 recurring 方法 + `subscription_*` 事件(带 period + 事件时间)。 |
| D4 | tier 加 `stripe_price_id`;invoice 行**按匹配 price/item 选取**,非恰好一条受支持周期行 → 拒绝告警。 |
| D5 | `payment_provider_events` 事件账本 + **认领/fencing**(received→processing 条件更新 + claim token + stale 恢复)+ 事件时间防乱序 + 冲突时权威 Stripe 读。 |
| D6 | `payment_requests.provider_invoice_ref` + `UNIQUE(provider,provider_invoice_ref)`;webhook 与 reconcile 同走 `applyPaidInvoice(invoiceId)`。 |
| D7 | 对账 `subscription.reconcile`(对象级幂等 + 扩展状态集 + 回溯窗口);结构性 fail-safe(权益=已付 period.end,不加 Core 宽限)。 |
| D8 | 手动提醒 = `provider=NULL` 订阅 + `subscription.renewal_reminder`(前 7 天可配)。取消默认 period-end。 |

## 3. Schema + 迁移（PR-A）

新增:
```ts
subscriptions(
  id, user_id→users, tier_id→membership_tiers,
  status: "pending"|"active"|"past_due"|"canceled"|"expired",
  provider text NULL, provider_subscription_ref text NULL,
  current_period_ends_at timestamptz NULL,
  cancel_at_period_end boolean default false, canceled_at timestamptz NULL,
  status_event_at timestamptz NULL, version int default 0,
  created_at, updated_at
)  // UNIQUE(provider, provider_subscription_ref) WHERE provider_subscription_ref IS NOT NULL

payment_provider_events(
  id, provider, provider_event_id, event_type, object_ref,
  provider_created_at timestamptz,
  status: "received"|"processing"|"processed"|"failed",
  locked_by text NULL, locked_at timestamptz NULL, attempts int default 0,
  processed_at NULL, error NULL, created_at
)  // UNIQUE(provider, provider_event_id)
```
`payment_requests` 加 `subscription_id uuid NULL` + `provider_invoice_ref text NULL` + `UNIQUE(provider, provider_invoice_ref)`(部分,ref 非空)。`membership_tiers` 加 `stripe_price_id text NULL`。

**无需迁移现有 `memberships`**(复用现有按笔模型)。`drizzle-kit generate` → 提交迁移 + snapshot,核对仅本切片变更。

## 4. 会员授予路径（PR-A,membership 模块）

新增 `grantMembershipForPeriod({userId,tierId,source,startsAt,endsAt,paymentRequestId,correlationId,causationId}, tx)`:
- **逐字写入** `startsAt`/`endsAt`(= Stripe invoice period.start/end),**不**重锚 now/current;INSERT 一行 `memberships`(status active)+ 审计(同现有 grant 范式)。
- 现有 `grantMembership`(重锚 + durationDays)**不动**,供手动提醒/人工/一次性继续用。
- 反转沿用 `revokeMembership`/#49(按 `granted_membership_id`)——**不改**。
- 测试:订阅行 `endsAt===period.end`;不同系统时间下 `getActiveMembership` 投影一致;跨 tier(高 tier active + 低 tier 订阅)正确;中间期反转留空洞。

## 5. provider 抽象 + webhook 认领/fencing（PR-A）

`providers/index.ts`:`NormalizedPaymentEvent` 加 `subscription_activated`/`subscription_renewed`(带 `periodStart/periodEnd/amountMinor/currency/providerInvoiceRef/paymentRef`)/`subscription_payment_failed`/`subscription_canceled`,均带 `providerEventId` + `providerCreatedAt`。`PaymentProvider` 加可选 `createSubscriptionCheckout?`/`cancelSubscription?`。

`providers/stripe.ts`:
- `createSubscriptionCheckout`:Checkout `mode:'subscription'`,`line_items:[{price: tier.stripePriceId, quantity:1}]`,`metadata`+`subscription_data.metadata` 带**本地 subscriptionId** + `app:'openlayerlypro'`。
- `cancelSubscription(ref,{atPeriodEnd})`。
- `parseWebhook`(验签后,每事件取 `event.created` 作 `providerCreatedAt`):
  - `customer.subscription.created|updated` → `subscription_activated`(`current_period_end`)。
  - `invoice.paid`(billing_reason subscription_create/cycle)→ `subscription_renewed`;**按匹配 `stripe_price_id`/subscription item 选 invoice 行**取 `period.start/end`、`amount`、`currency`、`invoice.id`(→ `providerInvoiceRef`)、`payment_intent`、metadata subscriptionId;**非恰好一条受支持周期行 → 报错/告警,不取首行**。
  - `invoice.payment_failed` → `subscription_payment_failed`;`customer.subscription.deleted` → `subscription_canceled`;其余维持/`ignored`。

**webhook 路由(认领/fencing,复用 ADR 0003 范式)**:
1. upsert `payment_provider_events`(`UNIQUE(provider,event_id)`);已 `processed` → 200 no-op。
2. **认领**:`received/failed → processing` 条件更新 + 随机 `locked_by` token;认领失败(他人已认领)→ 200(交给认领者)。
3. 认领成功者在事务内执行业务 + 审计/outbox + 置 `processed`(尽量同事务);**fencing**:写回 `processed` 时校验 `locked_by` 仍为本 token,否则放弃。
4. 失败 → `failed`(可重试);`processing` 超时由 stale 回收(同 outbox lease)。

## 6. 续费业务（PR-A,统一 `applyPaidInvoice`)

webhook 与 reconcile **都调** `applyPaidInvoice({providerInvoiceRef, providerEventId, subscriptionRef, period, amount, currency, paymentRef}, tx)`:
- **对象级幂等**:`payment_requests` 按 `UNIQUE(provider,provider_invoice_ref)` 插入;冲突 = 已处理该期 → no-op。
- **顺序无关恢复**:按 metadata subscriptionId / `provider_subscription_ref` upsert 本地 subscription(`pending→active`);确属本应用但无法解析 → 可重试/落库,不 no-op。
- **金额校验**(与 tier 价一致)。
- **按 invoice 决策**:只要该 invoice 未被反转就开通,**不**因 subscription 当前 `canceled` 拒绝。
- 事务内:`payment_request(approved, subscription_id, provider_invoice_ref, provider_event_id, amount/currency)` + `grantMembershipForPeriod(period)` + 更新 subscription `current_period_ends_at`(按 `providerCreatedAt` 防乱序)+ 审计(`action='subscription_renewed'`)+ 续费邮件 task。

其余事件:`subscription_activated` upsert 订阅(防乱序);`subscription_payment_failed` → `past_due`(按事件时间防乱序,旧 failed 重放忽略,不动权益);`subscription_canceled` → `canceled`/`expired`(不立即撤权,自然到期)。退款/拒付复用 #49 吊销对应行。

下单 `POST /api/payments/subscribe`:校验 tier 有 `stripe_price_id` → 先建 `subscription(status='pending')` → `createSubscriptionCheckout`(metadata 带本地 id)→ redirectUrl。

## 7. 取消（PR-A）

`POST /api/me/subscription/cancel` → `cancelSubscription(ref,{atPeriodEnd:true})` → 本地 `cancel_at_period_end=true`;webhook 最终 `canceled`。会员用到当前已付周期末。立即取消可选(不退已用)。

## 8. 对账安全网（PR-A）

`subscription.reconcile` durable task(周期性):
- 拉 Stripe 权威状态(`subscriptions.retrieve` + `invoices.list`),对每条已付 invoice 调 `applyPaidInvoice(invoice.id,...)` → **`UNIQUE(provider_invoice_ref)` 保证与 webhook 不重复授予同一期**;修正 subscription 状态。
- **覆盖状态集**:`active`/`past_due` + **`pending`**(activation 与 paid 都丢)+ **近期 `canceled`/`expired`**(可能仍缺某期已付 invoice)+ **未解析的 provider-ref 恢复记录**;终态订阅在文档化的 invoice 回溯/保留窗口后停止对账。
- **结构性 fail-safe**:权益=已付 period.end,漏回调不超期;`past_due` 不延长权益;不加 Core 宽限窗口。
- 与 webhook 走同一幂等路径,反复运行不重复。

## 9. tier / UI / i18n

tier 编辑加 `stripe_price_id`(预建 recurring Price 说明)。`me`:订阅状态 + 下次续费 + 取消;可订阅 tier 显示订阅入口(与一次性/人工并列)。后台:订阅列表 + 取消 + 手动提醒下次时间。locked/未登录不显示。`{zh,en,ja}.ts` + 邮件:订阅/取消/续费成功/扣款失败/到期提醒。不加未使用 key。

## 10. 手动周期提醒（PR-B）

`provider=NULL` 订阅 + task `subscription.renewal_reminder`(payload `{subscriptionId}`):创建/续费后按到期前 N 天(`SUBSCRIPTION_REMINDER_LEAD_DAYS` 默认 7,上下限)`enqueueTask(runAfter)`;handler 校验仍 active/未取消 → 提醒邮件 → 重排(dedupeKey 含期号防同期重复)。粉丝走现有入会再付一期(`grantMembership`,durationDays)→ 重排。

## 11. 测试（全部必须,真实 PG）

**确定性 / 不超界 / 跨 tier**
- 同一行集合在**不同系统时间** `getActiveMembership` 投影一致。
- 订阅行 `endsAt===invoice period.end`,**权益不超过已付边界**(不变量)。
- 高 tier active + 低 tier 订阅(跨 tier);中间期反转留空洞、跨 tier 反转;并存手动/一次性时按笔反转只撤对应行(#49 回归)。

**顺序 / 并发 / fencing**
- `invoice.paid` 早于 `subscription.created` 仍开通;`subscription.deleted` 早于已付 invoice,该 invoice 仍开通;`failed→paid→旧 failed 重放` 不回退。
- **并发同一 webhook 两次** → 仅认领者执行一次(fencing);stale processing 可恢复;旧 token 失效无法完成。

**对账 / invoice 身份**
- reconcile 在 late webhook 之前授予,之后原事件到 → 不重复(`UNIQUE(provider_invoice_ref)`);
- `pending` 全丢 → reconcile 补齐;canceled-before-missing-paid → 补齐;并发 reconcile / reconcile 与 webhook **竞争同一 invoice** → 仅一次授予。
- invoice 多行/无受支持周期行 → 拒绝告警,不取首行。

**周期 / 其他**
- 月末/2月·闰年/非默认 anchor → 取 Stripe 实际 period;金额校验;reversal-first;不碰卡号;非 Stripe provider 优雅降级。
- 手动提醒(PR-B):前 N 天 + 重排 + 同期不重复 + 失效不再提醒。

## 12. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm exec drizzle-kit generate   # 应有迁移：核对仅本切片变更
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 13. PR

- base `main`,Draft 直到真实 PG 集成 + 完整 CI 全绿。两 PR:
  - PR-A `feat(payments): Stripe subscription auto-renewal`(§3–9)。
  - PR-B `feat(membership): manual renewal reminders`(§10,依赖 PR-A)。
- 描述列出:复用 memberships 按笔模型(无迁移)、`grantMembershipForPeriod`、subscriptions/事件账本 + 认领fencing、`provider_invoice_ref` 对象级幂等 + `applyPaidInvoice`、顺序无关 + 按 invoice 决策、Stripe 实际周期 + 行精确选取、对账(扩展状态集)、结构性 fail-safe、取消、手动提醒、UI/i18n、全部测试、PostgreSQL 测试、CI。

## 14. 验收 checklist

- [ ] 复用 `memberships` 按笔账本:每笔已付 invoice 一行、Stripe 实际周期、反转吊销那一行;**无 memberships 迁移、不改 #49**
- [ ] `grantMembershipForPeriod` 逐字写 period 不重锚;投影确定性 + 不超已付边界(测试)
- [ ] 事件账本 + **认领/fencing**:并发同一事件仅执行一次;stale 恢复;旧 token 失效
- [ ] `provider_invoice_ref` + `UNIQUE`;webhook 与 reconcile 同走 `applyPaidInvoice`,同期仅授予一次
- [ ] 顺序无关 + 按 invoice 决策(deleted 早于已付 invoice 仍开通);invoice 行按 price 精确选取
- [ ] 对账覆盖 pending/active/past_due/近期 canceled/未解析恢复 + 回溯窗口;漏 paid 自愈、漏取消不超期
- [ ] 取消 period-end 默认;手动提醒(PR-B)前 N 天 + 重排 + 不重复 + 失效停发
- [ ] 三来源并存正确;金额校验;不碰卡号;非 Stripe 优雅降级

## 不在本切片（后续）

支付宝/微信/PayPal 周期扣款(留接口);套餐升降级 proration/改 tier、优惠券/试用/暂停。
