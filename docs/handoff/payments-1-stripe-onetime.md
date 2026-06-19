# 交接：自动收付款 #1 — Stripe 一次性付款(happy path)

> 给执行 agent 的自包含实现说明。**前置依赖:#4/#6/#7 + 配置中心已在 main**。落地决策见 [ADR 0005](../adr/0005-auto-payments.md)(Accepted)。
>
> 开工前在 GitHub 建一个 issue(如「feat(payments): Stripe one-time auto-checkout」),PR 关联它。

这是自动支付的**第一个垂直切片 = 完整 happy path**:配置 → 在线下单 → Stripe 托管 checkout → webhook 确认 → 自动开通会员 + 审计 + 邮件。**退款联动(复用 #6 reverse)放第二个切片**,本切片不做。

## 0. 必读

- [ADR 0005](../adr/0005-auto-payments.md)(provider 抽象、webhook 权威确认、幂等/验签/金额校验红线、与人工流共存)
- 现有代码(复用,别重写):
  - `src/modules/payment/index.ts`(`approvePaymentRequest` 的事务+审计+grant+outbox 入队模式——auto 确认要走**同一套**)
  - `src/modules/membership/index.ts`(`grantMembership(tx)`)、`src/modules/audit`(`recordAudit(tx)`)、`src/modules/tasks`(`enqueueTask(tx)`)
  - `src/modules/config/{smtp,storage}.ts` + `src/app/api/admin/config/{smtp,storage}` + 设置页卡片(配置组范式,照抄)
  - `src/modules/integration/registry.ts`(集成状态/测试范式)
  - `src/db/schema/index.ts`(`membership_tiers` / `payment_requests`)

## 1. 已锁定决策(来自 ADR 0005)

- 首个 provider = **Stripe**;但代码结构是 **provider 抽象 + 注册表**,为 alipay/wechat 预留,不写死 Stripe-only。
- **仅一次性付款**(Stripe Checkout `mode=payment`),无订阅。
- **托管 checkout**,本应用绝不接触卡号。
- **webhook 是唯一权威确认**:验签 + `provider_event_id` 幂等 + 金额校验 + 条件更新并发守卫。
- 人工收款码流**保持不变**,与 auto 并存。

## 2. 依赖

新增 npm 依赖 `stripe`(官方 SDK)。在 PR 说明里注明。

## 3. Schema 变更 `src/db/schema/index.ts` + 迁移

`membership_tiers` 加(可空;仅「可在线支付」的 tier 需要):

```ts
priceAmountMinor: bigint("price_amount_minor", { mode: "number" }),  // 最小货币单位（分）
currency: text("currency"),                                          // ISO 4217，如 "usd"
```

`payment_requests` 加 + 扩枚举:

```ts
status: text("status", {
  enum: ["pending_review", "pending_payment", "approved", "rejected", "cancelled", "reversed"],
}).notNull(), // 新增 pending_payment（auto 路径初始态）
flow: text("flow", { enum: ["manual", "auto"] }).notNull().default("manual"),
provider: text("provider"),            // 'stripe'（auto 时非空）
providerRef: text("provider_ref"),     // Stripe Checkout Session id
providerEventId: text("provider_event_id"), // 幂等：处理过的 webhook 事件 id
amountMinor: bigint("amount_minor", { mode: "number" }),
currency: text("currency"),
```

索引/约束:
- `uniqueIndex("payment_requests_provider_event_id_unique").on(providerEventId)`(幂等;PG 允许多 NULL)
- `index("payment_requests_provider_ref_idx").on(providerRef)`(webhook 按 session id 回查)

迁移:`pnpm exec drizzle-kit generate`(加列 + 加枚举值 + 索引,增量低风险)。

## 4. provider 抽象 `src/modules/payment/providers/`

`index.ts`:

```ts
export type NormalizedPaymentEvent =
  | { type: "paid"; providerRef: string; providerEventId: string; amountMinor: number; currency: string }
  | { type: "ignored"; providerEventId: string };  // 非关心事件，直接 200 no-op

export interface PaymentProvider {
  id: "stripe";
  createCheckout(input: {
    requestId: string; amountMinor: number; currency: string;
    tierName: string; successUrl: string; cancelUrl: string;
  }): Promise<{ redirectUrl: string; providerRef: string }>;
  parseWebhook(rawBody: string, signature: string | null): Promise<NormalizedPaymentEvent>; // 验签失败 throw ApiError(401)
}

export function getPaymentProvider(id: string): PaymentProvider | null; // 注册表，未来加 alipay/wechat
```

`stripe.ts`(用 `stripe` SDK):
- `createCheckout`:`stripe.checkout.sessions.create({ mode:"payment", line_items:[{ price_data:{ currency, unit_amount:amountMinor, product_data:{ name:tierName } }, quantity:1 }], metadata:{ requestId }, success_url, cancel_url })` → 返回 `{ redirectUrl: session.url, providerRef: session.id }`。
- `parseWebhook`:`stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)`(验签;失败 throw 401)。`checkout.session.completed` 且 `payment_status==="paid"` → `paid`(providerRef=session.id 或 metadata.requestId 回查、amountMinor=session.amount_total、currency);其它事件 → `ignored`。
- key/secret 从配置中心读(见 §6),**不从 env 直读**。

## 5. Service `src/modules/payment/index.ts`(扩展)

### 5.1 创建在线下单

```ts
createAutoCheckout(input: { userId; tierId; successUrl; cancelUrl }): Promise<{ redirectUrl }>
```
- 校验 tier:`isActive && purchaseEnabled && priceAmountMinor != null && currency != null`,否则 `ApiError(400, "tierNotPayable")`。
- 复用现有「同 tier pending 去重」思路(避免重复挂单)。
- 事务内 `insert payment_requests`:`flow="auto"`、`status="pending_payment"`、`provider="stripe"`、`amountMinor`、`currency`、`durationDays`(取 tier)、`amountLabel`(展示用 tier.priceLabel)。
- 调 `provider.createCheckout({ requestId, ... })` → 回写 `providerRef`;返回 `redirectUrl`。
- ⚠️ provider 调用是外部 IO:先建 `pending_payment` 行(拿到 requestId)→ 再调 Stripe → 回写 providerRef。Stripe 调失败则该行保持 pending_payment(可由超时清理或用户重试覆盖)。

### 5.2 确认(webhook 调用)

```ts
confirmAutoPayment(event: NormalizedPaymentEvent & { type:"paid" }): Promise<void>
```
- **幂等**:事务内先按 `providerEventId` 查;已存在 → return(no-op)。
- 条件更新 `where provider_ref=? and status='pending_payment'` → `approved`,同时写 `providerEventId`、`reviewedAt`。命中 0 行 → 已处理/不存在 → return no-op(不报错,让 webhook 返回 200)。
- **金额校验**:`event.amountMinor === row.amountMinor && event.currency === row.currency`,否则 throw + 不开通(告警)。
- 复用 approve 的同一套:`grantMembership(tx, { source:"payment_review"... })`(或新 source `"payment_auto"`,见下)→ 回写 `granted_membership_id` → `recordAudit(tx, { action:"payment_auto_paid", causationId? , correlationId })` → `enqueueTask(tx, 会员开通邮件)`。
- 可选:`memberships.source` 加枚举值 `"payment_auto"` 以区分自动/人工(也可复用 `payment_review`;建议新增,审计更清晰)。

> 整个 confirm 在**一个事务**内:付款态 + 会员 + 审计 + 邮件入队同提交/同回滚(完全对齐 #6)。

## 6. 配置中心 + 后台

仿 `config/smtp.ts`:新增加密组 `stripe`:`{ secretKey, webhookSecret, publishableKey?, currency, enabled }`(secretKey/webhookSecret 为敏感字段,掩码、加密存储,接口只回是否已设置)。
- `src/modules/config/stripe.ts`(get/set + `getStripeConfig()`)。
- `src/app/api/admin/config/stripe/route.ts`(GET/PUT/DELETE,`requireAdmin`)。
- 设置页加「在线支付(Stripe)」卡片(照抄 storage 卡片范式)。
- 接入 `integration/registry`:展示 configured/enabled 状态(test 可选:校验 secretKey 能否 `stripe.balance.retrieve()`)。

## 7. Webhook 路由 `src/app/api/payments/webhook/stripe/route.ts`(新建)

- `export const runtime = "nodejs"`;**必须读 raw body**:`const raw = await req.text()`(不要 `req.json()`,验签需要原文)。
- 取 `stripe-signature` 头 → `provider.parseWebhook(raw, sig)`(验签失败 → 401)。
- `paid` → `confirmAutoPayment(event)`;`ignored` → 直接 200。
- 始终对**已验签**的事件返回 2xx(即使 no-op);验签失败返回 4xx。处理抛错返回 5xx 让 Stripe 重试(幂等兜底)。
- **不**加 `requireAdmin`(这是服务器对服务器回调,鉴权=验签)。
- 不记录 raw body / secret 到日志。

## 8. 前台 checkout

- 在 `src/app/(site)/checkout/[tierId]` 或 tiers 页:若 tier「可在线支付」(`priceAmountMinor!=null` 且 Stripe 已启用),显示「在线支付」按钮 → `POST /api/checkout/auto`(`requireUser`)→ 拿 `redirectUrl` → 前端 `window.location = redirectUrl`。
- 人工收款码流保持并存(二选一)。
- `success_url` → `/me/orders`(或带 `?paid=1` 的状态页);`cancel_url` → 回 checkout。注意:**成功页不开通会员**,开通只认 webhook;成功页可显示「支付处理中,稍候刷新」。

## 9. i18n

`{zh,en,ja}.ts` 补:在线支付按钮、支付处理中、`tierNotPayable`、后台 Stripe 配置卡片文案等。

## 10. 测试

- provider 单测(mock `stripe` SDK):`createCheckout` 入参正确;`parseWebhook` 验签失败 → 401、`checkout.session.completed paid` → `paid` 事件、其它 → `ignored`。
- 真实 PG 集成(参照 `payment/index.integration.test.ts`,mock Stripe SDK 调用):
  - `createAutoCheckout`:非可付费 tier → 400;成功建 `pending_payment` 行 + 回写 providerRef。
  - `confirmAutoPayment`:`pending_payment → approved` 一次成功 + 开通会员 + 写 `granted_membership_id` + 审计 + email 任务入队。
  - **幂等**:同 `providerEventId` 二次 → no-op,不重复开通。
  - **并发/重放**:`status != pending_payment` 时 → no-op。
  - **金额不符** → 拒绝、不开通。
  - webhook 路由:伪造/缺签名 → 401。
- Stripe **test mode** 真连测试为可选手动验证(你有沙箱);CI 用 mock。

## 11. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 12. PR

- base `main`,draft,标题 `feat(payments): Stripe one-time auto-checkout`。
- 描述:新增 `stripe` 依赖、schema/迁移、provider 抽象、配置中心 stripe 组、webhook 路由(验签/幂等/金额校验)、前台在线支付入口、与人工流共存;**退款联动在下一个切片**。
- 关联对应 issue。

## 13. 验收 checklist

- [ ] provider 抽象 + 注册表(Stripe 适配器,为 alipay/wechat 预留)
- [ ] tier 结构化定价;非可付费 tier 不出在线支付入口
- [ ] 在线下单建 `pending_payment` + 跳转 Stripe 托管 checkout
- [ ] webhook 验签 + 事件幂等 + 金额校验 + 条件更新守卫
- [ ] 确认走与人工 approve 同一事务(grant + 审计 + 邮件 outbox)
- [ ] 人工收款码流不受影响
- [ ] 不接触卡号、不泄露密钥
- [ ] 单测 + 真实 PG 集成覆盖幂等/重放/金额不符/验签失败

## 不在本切片(后续)

- 退款 / chargeback → 复用 #6 `reversePaymentApproval`(切片 #2)。
- 订阅/自动续费;多币种展示;对账报表。
- 支付宝/微信适配器。
