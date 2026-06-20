# 交接：周期性会员 — Stripe 自动续费 + 手动周期提醒

> 给执行 agent 的自包含实现说明。前置依赖:当前 `main`(已含 v0.2 自动支付 / Stripe 一次性 / 退款·拒付反转、durable tasks、会员生命周期)。落地决策见 [ADR 0009](../adr/0009-recurring-subscriptions.md)。
>
> 开工前建 issue;PR 保持 Draft,直到真实 PG 集成测试 + 完整 CI 全绿。
>
> **建议分两个 PR 串行**:**PR-A = Stripe 自动续费**(schema + provider recurring + webhook + 续费 grant + 取消 + 后台/me UI);**PR-B = 手动周期提醒**(provider=NULL 订阅 + 到期前提醒 task + 重排)。本文件覆盖两者,§标注所属 PR。

## 0. 红线（碰钱 / 会员,务必遵守）

1. **绝不接触卡号 / 敏感支付数据**:一律 Stripe 托管 Checkout / 官方 SDK;只存 `provider_subscription_ref` / `provider_event_id` / 归一化结果。
2. **续费 webhook 幂等**:每个 `provider_event_id` 唯一约束 + no-op 200;重放 / 乱序 / 重复**绝不重复叠加会员**。
3. **reversal-first**(同 #49):反转先到时,后到的续费 paid **不得**开通;退款 / 拒付撤销**对应那一期**(`granted_membership_id`)。
4. **续费不发明新会员状态**:每期成功 = `grantMembership`/`extendMembership` 叠加一个周期(ADR 0001),走与一次性 approve **同一事务 + 审计 + outbox**。
5. **金额校验**:续费金额与 tier 结构化价(`price_amount_minor`/`currency`)一致才接受。
6. **三种来源并存**:人工 / 一次性 / 订阅互不互斥;不得在加订阅时破坏现有人工 / 一次性 / 反转回归。
7. **验签密钥走配置中心加密**,不入日志 / 审计。

## 1. 现状（必读,直接扩展别重写）

- **会员**`src/modules/membership/index.ts`:`grantMembership({userId,tierId,source,durationDays?,correlationId?,...}, tx?)` 在已有 active 会员上**顺延 `endsAt`**;`extendMembership`、`revokeMembership(id, cmd, tx?)`;`source` 枚举含 `payment_auto`;状态 `active/suspended/revoked` + `version` 乐观锁。
- **支付**`src/modules/payment/index.ts`:`confirmAutoPayment`/`reverseAutoPayment`/`applyApprovedPaymentReversal`(#49);grant 与审计 / outbox 已事务化。
- **provider 抽象**`src/modules/payment/providers/index.ts`:`PaymentProvider`(`createCheckout`/`getCheckoutState`/`parseWebhook`/`resolveCheckoutByPaymentIntent`/`testConnection`)+ `getPaymentProvider('stripe')`(读配置中心 `getStripeConfig()`);`NormalizedPaymentEvent`(paid/expired/refunded/disputed/ignored)。Stripe 适配器 `providers/stripe.ts`。
- **webhook**`src/app/api/payments/webhook/stripe/route.ts`:raw body 验签 → `parseWebhook` → 归一化处理(幂等 + 条件更新)。
- **schema**`src/db/schema/index.ts`:`membershipTiers`(有 `priceAmountMinor`/`currency`/`durationDays` 默认 31/`purchaseEnabled`);`paymentRequests`(status 枚举 pending_review/pending_payment/approved/rejected/cancelled/reversed;flow manual/auto;provider/providerRef/providerEventId/providerPaymentRef/reversalEventId/amountMinor/currency/grantedMembershipId);`memberships`(source 枚举含 payment_auto;startsAt/endsAt/status/version)。
- **durable tasks**`src/modules/tasks/`:`enqueueTask(tx,{kind,payload,runAfter?,dedupeKey?})` + handlers(`runTaskHandler` switch);`tasks.kind` 为无约束 `text`(新增 kind 无需迁移)。
- **邮件**`src/modules/mail/`:i18n 邮件(开通 / 驳回 / 验证码);按收件人 `users.locale` 发送。
- **配置中心**`getStripeConfig()`(加密 `app_settings`)。

## 2. 锁定决策（见 ADR 0009;动工前有异议先提）

| # | 决策 |
|---|---|
| D1 | 新增 provider 无关 `subscriptions` 表;续费 = 复用 `grantMembership`/`extendMembership` 叠加时间窗,**不新增会员状态**。 |
| D2 | `PaymentProvider` 加**可选** `createSubscriptionCheckout?`/`cancelSubscription?` + 周期归一化事件;仅 Stripe 实现,其他 provider 留接口。 |
| D3 | 每期一笔 `payment_request`(加 `subscription_id`),走与一次性 approve **同一** grant / 审计 / 反转 / 幂等路径。 |
| D4 | tier 加 `stripe_price_id`(指向预建 recurring Price);「可订阅」由其是否存在判定(评审可改为显式列)。 |
| D5 | 手动提醒 = `provider=NULL` 订阅 + durable task 到期前 N 天发提醒;续费仍走现有入会流。 |
| D6 | 取消默认 `cancel_at_period_end`(用到期末);立即取消为可选。 |
| D7 | 三种来源并存,统一会员生命周期。 |

## 3. Schema + 迁移（PR-A）

`src/db/schema/index.ts`:

```ts
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tierId: uuid("tier_id").notNull().references(() => membershipTiers.id),
  status: text("status", { enum: ["active", "past_due", "canceled", "expired"] }).notNull(),
  provider: text("provider"),                       // 'stripe' | null（null = 手动提醒）
  providerSubscriptionRef: text("provider_subscription_ref"),
  providerEventId: text("provider_event_id"),       // 最近处理的事件（可选；幂等主键在 payment_requests）
  currentPeriodEndsAt: timestamp("current_period_ends_at", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  version: integer("version").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
// 部分唯一索引：同一 provider 的 subscription ref 唯一
//   UNIQUE(provider, provider_subscription_ref) WHERE provider_subscription_ref IS NOT NULL
```

- `paymentRequests` 加 `subscriptionId uuid NULL references(subscriptions.id)`。
- `membershipTiers` 加 `stripePriceId text NULL`。
- `pnpm exec drizzle-kit generate` → **本切片有真实迁移**(新表 + 两列 + 部分唯一索引);提交迁移 + snapshot。

## 4. provider 抽象扩展（PR-A）

`src/modules/payment/providers/index.ts`:
- `NormalizedPaymentEvent` 增加 `subscription_activated` / `subscription_renewed` / `subscription_payment_failed` / `subscription_canceled`(字段见 ADR 0009 §2)。
- `PaymentProvider` 增**可选** `createSubscriptionCheckout?` / `cancelSubscription?`。

`providers/stripe.ts`:
- `createSubscriptionCheckout`:Stripe Checkout `mode:'subscription'`,`line_items:[{price: priceRef, quantity:1}]`,`client_reference_id`/`metadata` 带本地 `subscriptionRef` + `app:'openlayerlypro'`(归属判定,沿用现有归属范式),`success_url`/`cancel_url`。
- `cancelSubscription(ref,{atPeriodEnd})`:`stripe.subscriptions.update(ref,{cancel_at_period_end:true})` 或 `stripe.subscriptions.cancel(ref)`。
- `parseWebhook` 扩展(验签后)映射:
  - `customer.subscription.created`/`...updated`(active)→ `subscription_activated`(带 `current_period_end`)。
  - `invoice.paid`(billing_reason=subscription_create/subscription_cycle)→ `subscription_renewed`(带 `amount_paid`/`currency`/`payment_intent`/`lines.period.end`)。
  - `invoice.payment_failed` → `subscription_payment_failed`。
  - `customer.subscription.deleted` → `subscription_canceled`。
  - 既有 `payment_intent.*`/`charge.refunded`/`charge.dispute.created` 维持(退款 / 拒付仍走 #49)。
  - 非订阅 / 未归属 / 不识别 → `ignored`(避免 Stripe 因不可映射事件无限重试)。

## 5. 续费处理（PR-A,payment 模块）

webhook 路由对周期事件分派到 payment 模块新函数(全部事务内,复用现有审计 / outbox):

- `activateSubscription(event)`:按 `providerSubscriptionRef` 找 / 建本地 subscription(`status='active'`,`current_period_ends_at`),回填 `provider_subscription_ref`;**幂等**(已存在则更新,不重复建)。
- `applySubscriptionRenewal(event)`:
  1. `provider_event_id` 去重(查到已处理 → 200 no-op)。
  2. 金额校验(与 tier 价一致)。
  3. 事务内:创建 `payment_request(flow='auto',provider='stripe',status='approved',subscription_id,amount/currency,provider_event_id,provider_payment_ref)` + `grantMembership(tx, source='payment_auto', tierId, durationDays=tier.durationDays, correlationId=event)` + 更新 subscription `current_period_ends_at`/`status='active'` + `recordAudit(tx, action='subscription_renewed', causationId)` + `enqueueTask(tx, 续费成功邮件)`。
  4. **reversal-first 守卫**:若该期已被反转 / subscription 已 canceled,则不 grant(同 #49 语义)。
- `markSubscriptionPastDue(event)`:subscription `status='past_due'`(乐观锁 `version`);**不**改会员(会员用到当前 `endsAt`,靠 Stripe dunning 重试);记审计。
- `cancelSubscriptionFromWebhook(event)`:subscription `status='canceled'`,`canceled_at=now`;不立即撤销会员(用到期末自然失效);记审计。
- **退款 / 拒付**:复用 #49,按 `granted_membership_id` 撤销对应那一期叠加(无需新代码,确认续费 payment_request 也带 `provider_payment_ref` 供 charge 反查)。

下单(创建订阅):`POST /api/payments/subscribe`(登录用户)→ 校验 tier 有 `stripe_price_id` 且 `purchase_enabled` → 建本地 subscription(`provider='stripe'`,`status='active'` 占位 / 或 `past_due` 直到首期 paid)→ `createSubscriptionCheckout` → 返回 redirectUrl。归属与并发守卫沿用一次性 checkout 范式。

## 6. 取消（PR-A）

- 用户 `POST /api/me/subscription/cancel`(或后台)→ `cancelSubscription(ref,{atPeriodEnd:true})` → 本地 `cancel_at_period_end=true`;webhook `subscription_canceled` 最终置 `status='canceled'`。会员用到当前 `endsAt`。
- 立即取消为可选项(`atPeriodEnd:false`),不退已用周期。

## 7. 手动周期提醒（PR-B）

- 一个 `provider=NULL` 的 subscription(用户在「无卡 / 人工」入会时可选「按期提醒」)。
- 新 task kind `subscription.renewal_reminder`(payload `{subscriptionId}`):
  - 创建 / 续费后,按 `current_period_ends_at`(或 membership `endsAt`)**前 N 天**(默认 7,可配 `SUBSCRIPTION_REMINDER_LEAD_DAYS`,设上下限)`enqueueTask(runAfter=...)`。
  - handler:校验 subscription 仍 active / 未取消 → 发提醒邮件(mail i18n,按 `users.locale`)→ **重排下一次提醒**(避免漏发 / 重复:用 dedupeKey 含「期号 / period end」防同期重复)。
  - 粉丝走现有人工审核或一次性 Stripe 再付一期 → 正常 `grantMembership` → 续费后重排。
- 会员到期未续 → 自然失效;subscription 可标 `expired`。

## 8. tier 编辑 / 配置（PR-A）

- 后台 tier 编辑加 `stripe_price_id`(可空);填了即「可订阅」。
- 文档说明:price 在 Stripe 预建 recurring Price,周期 / 币种以 Stripe 侧为准,应与 tier `durationDays`/`currency` 对应。

## 9. UI（PR-A 后台 + me;PR-B 提醒选项）

- **me**:展示当前订阅(tier / 状态 / 下次续费 `current_period_ends_at` / provider)+ 取消按钮;tier 列表对「可订阅」tier 显示「订阅」入口(与一次性 / 人工并列)。
- **后台**:订阅列表(用户 / tier / 状态 / 下次续费 / provider / 取消);手动提醒订阅显示下次提醒时间。
- locked / 未登录不显示订阅操作。

## 10. i18n（PR-A/B）

`{zh,en,ja}.ts` + 邮件:订阅 / 取消 / 续费成功 / 扣款失败 / **到期提醒** 文案;tier「订阅」按钮;后台订阅列表标签。不加未使用 key。

## 11. 测试

**幂等 / 安全（最关键,真实 PG）**
- 同一续费事件重放 → 只叠加一期(`provider_event_id` 去重)。
- 乱序:反转先到 → 后到续费 paid 不 grant(reversal-first)。
- 金额不符 → 拒绝,不 grant。
- 退款 / 拒付 → 撤销对应那一期(`granted_membership_id`),不误伤其他期 / 其他来源叠加。
- 未归属 / 非订阅事件 → `ignored`,不 500、不无限重试。

**续费生命周期**
- activate → 首期 grant;cycle paid → 叠加 endsAt;past_due 不改会员;canceled → 不再续、会员到期自然失效。
- 取消(period end)→ 用到 endsAt;立即取消 → 标记正确,不退已用周期。

**手动提醒**
- 创建 / 续费后排了提醒 task,runAfter 正确(到期前 N 天)。
- handler 发一次提醒并重排;同期不重复(dedupeKey)。
- 取消 / 已失效 subscription 不再提醒。

**并存回归**
- 同一用户:一次性叠加 + 订阅续费 + 人工 → `endsAt` 正确叠加,`getActiveLevel` 正确。
- 现有人工 / 一次性 / 退款·拒付(#49)回归全绿。

**provider 抽象**
- 非 Stripe(未实现 recurring 方法)调用优雅降级 / 明确报错。

## 12. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm exec drizzle-kit generate   # 本切片应有迁移：核对仅含本切片变更
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 13. PR

- base `main`,Draft 直到真实 PG 集成 + 完整 CI 全绿。建议两 PR：
  - PR-A `feat(payments): Stripe subscription auto-renewal`(Closes 对应 issue,§3–6/8/9)。
  - PR-B `feat(membership): manual renewal reminders`(§7,依赖 PR-A)。
- 描述列出:subscriptions 表 + 迁移、provider recurring 扩展、webhook 续费 / 失败 / 取消、续费 grant 复用、退款·拒付反转复用、取消语义、手动提醒 task、UI、i18n、幂等 / reversal-first、PostgreSQL 测试、CI。

## 14. 验收 checklist

- [ ] `subscriptions` 表 + `payment_requests.subscription_id` + `membership_tiers.stripe_price_id` 迁移(仅本切片变更)
- [ ] Stripe `mode=subscription` checkout;首期 + 续费叠加会员(复用 grant / 审计 / outbox)
- [ ] 续费幂等(event id 去重)+ 金额校验 + reversal-first;退款 / 拒付撤销对应那一期
- [ ] 扣款失败 → past_due(不动会员);Stripe dunning 重试成功续费;最终取消 → 会员自然到期
- [ ] 取消(period end 默认 / 立即可选),不退已用周期
- [ ] 手动提醒:到期前 N 天发提醒 + 重排 + 同期不重复 + 取消不再提醒
- [ ] 三种来源并存,叠加 `endsAt`/`getActiveLevel` 正确;现有人工 / 一次性 / #49 回归全绿
- [ ] provider 抽象 recurring 方法可选,非 Stripe 优雅降级
- [ ] 绝不接触卡号;验签密钥不入日志 / 审计

## 不在本切片（后续）

- 支付宝 / 微信 / PayPal 的周期扣款(provider 留好接口,后续接入)。
- 套餐升降级 proration、订阅改 tier。
- 优惠券 / 试用期 / 暂停订阅。
