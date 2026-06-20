# 交接：周期性会员 — Stripe 自动续费 + 手动周期提醒

> 给执行 agent 的自包含实现说明。前置依赖:当前 `main`(已含 v0.2 自动支付 / Stripe 一次性 / 退款·拒付反转、durable tasks、会员生命周期)。落地决策见 [ADR 0009](../adr/0009-recurring-subscriptions.md)。
>
> 开工前建 issue;PR 保持 Draft,直到真实 PG 集成测试 + 完整 CI 全绿。
>
> **建议分两个 PR 串行**:**PR-A** = grant 账本 + 事件账本 + Stripe 自动续费;**PR-B** = 手动周期提醒。本文件覆盖两者,§标注所属 PR。
>
> ⚠️ 本切片的**重头是数据模型**(权益账本 + 事件账本),不是「调个 Stripe API」。评审(PR #59)已明确:不解决按期反转 / 顺序无关 / 实际周期 / 事件幂等乱序 / 按 invoice 决策,就不要写。

## 0. 红线（碰钱 / 会员,务必遵守）

1. **绝不接触卡号 / 敏感支付数据**:一律 Stripe 托管;只存 ref / event id / 归一化结果。
2. **权益按笔可反转**:退款 / 拒付只撤**对应那一期**的 grant,**绝不**吊销整行会员、绝不误伤手动 / 一次性 / 其他期。
3. **webhook 顺序无关**:`invoice.paid` 可能早于 `subscription.created`;不得假设顺序;owned-but-unresolved **不得**当永久 no-op(可重试 / 落库待处理)。
4. **权益窗口用 Stripe 实际 invoice period**,不用固定 `durationDays`(订阅);月末 / 2 月 / 闰年 / anchor 不漂移。
5. **事件幂等 + 防乱序**:provider 事件账本唯一约束 + 按 provider 事件时间拒绝过期事件。
6. **按 invoice 决策**:只看该 invoice 自身状态(是否被反转),**不**因 subscription 聚合 `canceled` 否决一笔已付 invoice。
7. **金额校验**;**验签密钥不入日志 / 审计**;三种来源并存,不破坏现有人工 / 一次性 / #49 回归。

## 1. 现状（必读,直接扩展别重写）

- **会员**`src/modules/membership/index.ts`:`grantMembership(...)` 现状在**同一 active 行顺延 `endsAt`**;`revokeMembership(id,...)` **吊销整行**(← 这正是 B1 要改的);`source` 枚举含 `payment_auto`;`getActiveLevel`/`getActiveMembership` 按 `endsAt>now`。
- **支付**`src/modules/payment/index.ts`:`confirmAutoPayment`/`reverseAutoPayment`/`applyApprovedPaymentReversal`(#49,现按 `granted_membership_id` 调 revoke 整行)。
- **provider 抽象**`src/modules/payment/providers/index.ts`:`PaymentProvider` + `NormalizedPaymentEvent`(paid/expired/refunded/disputed/ignored);`getPaymentProvider('stripe')` 读 `getStripeConfig()`。Stripe 适配器 `providers/stripe.ts`。
- **webhook**`src/app/api/payments/webhook/stripe/route.ts`:raw body 验签 → parse → 幂等处理。
- **schema**`src/db/schema/index.ts`:`membershipTiers`(`priceAmountMinor`/`currency`/`durationDays`/`purchaseEnabled`);`paymentRequests`(status/flow/provider*/amount/currency/`grantedMembershipId`/`providerEventId`);`memberships`(source/startsAt/endsAt/status/version)。
- **durable tasks**`enqueueTask(tx,{kind,payload,runAfter?,dedupeKey?})`;`tasks.kind` 无约束 text。
- **邮件**`src/modules/mail/` 按 `users.locale`。配置中心 `getStripeConfig()`。

## 2. 锁定决策（见 ADR 0009）

| # | 决策 |
|---|---|
| D1 | **不可变 `membership_grants` 账本**:每笔授予一行、可独立反转;有效会员 = 未反转 grant 重算的派生投影。所有来源(人工/一次性/订阅/gift)统一写账本。 |
| D2 | provider 无关 `subscriptions` 表(状态含 `pending`);provider 只是续费来源。 |
| D3 | `PaymentProvider` 加可选 `createSubscriptionCheckout?`/`cancelSubscription?` + `subscription_*` 归一化事件(带 invoice 实际 period + 事件时间);仅 Stripe 实现。 |
| D4 | 权益窗口 = Stripe invoice `period.start/end`(订阅);顺序无关恢复(先建 pending 订阅 + metadata + invoice.paid upsert + owned-unresolved 可重试)。 |
| D5 | `payment_provider_events` 事件账本(唯一约束 + 事件时间防乱序);按 invoice 决策,不按聚合状态。 |
| D6 | 续费 = 追加一笔 grant + 重算;退款/拒付反转**那一笔 grant**(改造 #49 路径,不吊销整行)。 |
| D7 | 手动提醒 = `provider=NULL` 订阅 + `subscription.renewal_reminder` task;手动 grant period 用 `durationDays`。 |

## 3. Schema + 迁移（PR-A,本切片最重的一块）

新增 `membership_grants`、`subscriptions`、`payment_provider_events`,`payment_requests.subscription_id`,`membership_tiers.stripe_price_id`(字段见 ADR 0009 §1/§2/§5)。

**现有 memberships 迁移**(评审待确认 2,默认推荐):把每个现有 `memberships` 行回填成**一笔 legacy `membership_grant`**(`source` 沿用、`period_start=starts_at`、`period_end=ends_at`、`payment_request_id` 尽量回填),之后有效会员一律走账本重算。`memberships` 表保留为**派生投影**(或读时计算 + 缓存)。迁移要有**幂等、可回滚、回归测试**(迁移前后 `getActiveLevel` 不变)。

`pnpm exec drizzle-kit generate` → 提交迁移 + snapshot;核对仅含本切片变更。

## 4. 权益账本 + 重算（PR-A,membership 模块）

- `grantMembership(...)` 改为:**追加一笔 `membership_grant`**(带 period + 来源 + payment_request_id/subscription_id)→ **重算投影**。对外签名尽量兼容(内部改实现)。
- `recomputeMembership(userId, tierId, tx)`:读该用户该 tier 所有**未反转** grant → 按 ADR 0009 §1 叠加规则算有效 `endsAt`/active → 更新派生 `memberships` 行(或缓存)。
- `reverseGrant(paymentRequestId | grantId, reason, tx)`:置 `reversed_at` → 重算。**退款/拒付(#49)改调它**,不再 `revokeMembership` 整行。
- **叠加重算规则**(评审待确认 1,默认推荐):有效到期 = 「从基准(`max(now, 既有active起点)`)起,按未反转 grant 的**时长之和**连续顺延」——反转中间一笔即减去其时长,后续不留洞。**写清并测试**(尤其反转中间期、并存手动)。
- 行级锁:重算与反转对该 user+tier 取 `FOR UPDATE`(或乐观 `version`)防并发。

## 5. provider 抽象扩展（PR-A）

`providers/index.ts`:`NormalizedPaymentEvent` 加 `subscription_activated`/`subscription_renewed`(带 `periodStart`/`periodEnd`/`amountMinor`/`currency`/`paymentRef`)/`subscription_payment_failed`/`subscription_canceled`,每个都带 `providerEventId` + `providerCreatedAt`。`PaymentProvider` 加可选 `createSubscriptionCheckout?`/`cancelSubscription?`。

`providers/stripe.ts`:
- `createSubscriptionCheckout`:Checkout `mode:'subscription'`,`line_items:[{price: tier.stripePriceId, quantity:1}]`,`metadata`/`subscription_data.metadata` 带**本地 subscriptionId** + `app:'openlayerlypro'`,success/cancel url。
- `cancelSubscription(ref,{atPeriodEnd})`:`subscriptions.update(cancel_at_period_end:true)` 或 `subscriptions.cancel`。
- `parseWebhook`(验签后)映射,**每个事件取 `event.created` 作 `providerCreatedAt`**:
  - `customer.subscription.created|updated` → `subscription_activated`(带 `current_period_end`)。
  - `invoice.paid`(`billing_reason` ∈ subscription_create/subscription_cycle)→ `subscription_renewed`(带 `lines.data[].period.start/end`、`amount_paid`、`currency`、`payment_intent`、metadata 里的本地 subscriptionId)。
  - `invoice.payment_failed` → `subscription_payment_failed`。
  - `customer.subscription.deleted` → `subscription_canceled`。
  - 既有 `payment_intent.*`/`charge.refunded`/`charge.dispute.created` 维持。未归属/不识别 → `ignored`。

## 6. webhook 处理（PR-A,顺序无关 + 事件账本 + 按 invoice 决策）

webhook 路由对所有事件:
1. **先写 `payment_provider_events`**(唯一约束去重);已 `processed` → 200 no-op。
2. 分派到 payment 模块(全部事务内):
   - `subscription_activated`:按 metadata/ref **upsert** 本地 subscription（`pending→active`,回填 ref/`current_period_ends_at`);幂等;**用 `providerCreatedAt` 防乱序**(早于 `status_event_at` 的忽略)。
   - `subscription_renewed`:
     a. `payment_request.provider_event_id` + 事件账本双重去重。
     b. **顺序无关恢复**:若本地 subscription 不存在,按 metadata 的 subscriptionId / `provider_subscription_ref` **upsert 恢复**;若确属本应用但仍无法解析 → **可重试错误 / 落库待处理**(不 200 no-op)。
     c. 金额校验。
     d. **按 invoice 决策**:只要这笔 invoice 未被反转就开通——**不**因 subscription 当前 `canceled` 而拒绝。
     e. 事务内:`payment_request(approved, subscription_id, provider_event_id, provider_payment_ref, amount/currency)` + **追加 `membership_grant`(period = invoice period.start/end)** + `recomputeMembership` + 审计 + 续费邮件 task;更新 subscription `current_period_ends_at`（按 `providerCreatedAt` 防乱序）。
   - `subscription_payment_failed`:`status='past_due'`,**按事件时间防乱序**(旧 failed 重放被忽略,不回退);不动权益(靠 Stripe dunning;会员用到当前账本到期)。记审计。
   - `subscription_canceled`:`status='canceled'`/`expired`,`canceled_at`;**不**立即撤销权益(用到期末自然失效)。
   - 标记 `payment_provider_events.processed`。
- 退款/拒付(`charge.refunded`/`dispute`):复用 #49 入口,反转动作改为 `reverseGrant(该 invoice 对应的 payment_request)`。

下单:`POST /api/payments/subscribe`(登录)→ 校验 tier 有 `stripe_price_id` → **先建本地 `subscription(status='pending')`** → `createSubscriptionCheckout`(metadata 带本地 id)→ 返回 redirectUrl。

## 7. 取消（PR-A）

`POST /api/me/subscription/cancel` → `cancelSubscription(ref,{atPeriodEnd:true})` → 本地 `cancel_at_period_end=true`;webhook 最终置 `canceled`。会员用到当前账本到期。立即取消为可选(不退已用周期)。

## 8. 手动周期提醒（PR-B）

`provider=NULL` 订阅 + task kind `subscription.renewal_reminder`(payload `{subscriptionId}`):创建/续费后按到期前 N 天(`SUBSCRIPTION_REMINDER_LEAD_DAYS`,默认 7,设上下限)`enqueueTask(runAfter)`;handler 校验仍 active/未取消 → 发提醒邮件 → 重排(dedupeKey 含期号防同期重复)。粉丝走现有入会流再付一期 → 追加 grant(period 用 `durationDays`)→ 重排。

## 9. tier / UI / i18n

- tier 编辑加 `stripe_price_id`(预建 recurring Price 说明)。
- `me`:订阅状态 + 下次续费 + 取消;tier 列表对可订阅 tier 显示订阅入口(与一次性/人工并列)。后台:订阅列表 + 取消 + 手动提醒下次时间。locked/未登录不显示。
- `{zh,en,ja}.ts` + 邮件:订阅/取消/续费成功/扣款失败/到期提醒;后台标签。不加未使用 key。

## 10. 测试（评审要求,全部必须覆盖,真实 PG）

**顺序 / 乱序 / 幂等**
- `invoice.paid` **早于** `customer.subscription.created` → 首期正常开通(恢复)。
- `customer.subscription.deleted` **早于**已成功 `invoice.paid` → 该 invoice 仍开通(按 invoice 决策)。
- `failed → paid → 旧 failed 重放` → 不回退 past_due(事件时间防乱序)。
- 续费事件重放 → 只开通一期(事件账本 + payment_request 双守卫)。
- owned-but-unresolved paid → 可重试/落库,不被当永久 no-op。

**按笔反转 / 权益账本**
- 三期 grant,**只退中间一期** → 其余期/手动/其他来源权益不受损(重算正确)。
- 按期反转与**人工/一次性并存** → 只撤对应那一笔。
- 现有一次性/人工反转(#49)回归:升级为按笔反转后行为正确。

**实际周期**
- 月末 / 2 月·闰年 / 非默认 billing anchor → grant period 取 Stripe 实际值,不漂移。

**生命周期 / 并存 / 迁移**
- activate→首期;cycle→叠加;past_due 不动权益;canceled→自然到期;取消 period-end。
- 三来源并存 `getActiveLevel`/`endsAt` 正确。
- **迁移**:现有 memberships 回填 grant 账本后,`getActiveLevel`/有效到期与迁移前一致。
- 金额不符拒绝;reversal-first;不碰卡号;非 Stripe provider 优雅降级。

**手动提醒(PR-B)**:到期前 N 天排提醒 + 重排 + 同期不重复 + 取消/失效不再提醒。

## 11. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm exec drizzle-kit generate   # 本切片应有迁移：核对仅含本切片变更
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 12. PR

- base `main`,Draft 直到真实 PG 集成 + 完整 CI 全绿。两 PR:
  - PR-A `feat(payments): subscription entitlement ledger + Stripe auto-renewal`。
  - PR-B `feat(membership): manual renewal reminders`(依赖 PR-A)。
- 描述列出:grant 账本 + 迁移、事件账本、provider recurring 扩展、顺序无关 webhook、按 invoice 决策、实际周期、按笔反转(改造 #49)、取消、手动提醒、UI/i18n、全部测试场景、PostgreSQL 测试、CI。

## 13. 验收 checklist

- [ ] `membership_grants` 账本:每笔可独立反转;有效会员 = 未反转 grant 重算;所有来源统一写账本
- [ ] 现有 memberships 迁移到账本,`getActiveLevel`/到期不变(有测试)
- [ ] `payment_provider_events` 事件账本:唯一约束幂等 + 事件时间防乱序(failed→paid→旧failed 不回退)
- [ ] 顺序无关:invoice.paid 早于 subscription.created 仍开通;owned-unresolved 可重试不当 no-op
- [ ] 权益窗口 = Stripe invoice 实际 period(月末/2月/闰年/anchor 不漂移)
- [ ] 按 invoice 决策:deleted 早于已付 invoice,该 invoice 仍开通
- [ ] 按笔反转:退款/拒付只撤对应期,保留其他期/手动/一次性(#49 改造后回归绿)
- [ ] Stripe `mode=subscription` 开通 + 续费;金额校验;不碰卡号;密钥不入日志
- [ ] 取消 period-end 默认 / 立即可选,不退已用周期
- [ ] 手动提醒(PR-B):前 N 天 + 重排 + 同期不重复 + 失效不再提醒
- [ ] 三来源并存正确;provider recurring 方法可选,非 Stripe 优雅降级

## 不在本切片（后续）

- 支付宝 / 微信 / PayPal 周期扣款(provider 留接口)。
- 套餐升降级 proration / 改 tier、优惠券 / 试用期 / 暂停订阅。
