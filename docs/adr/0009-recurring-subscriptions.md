# ADR 0009：周期性会员（订阅自动续费 + 手动周期提醒）

- **Status**：Proposed ▶（2026-06-20；评审锁定后转 Accepted）
- **相关 issue**：v1.0 会员续费（待建 issue）
- **依赖**：[ADR 0001](0001-membership-lifecycle-model.md)（会员生命周期：叠加时间窗 + 存储态）、[ADR 0002](0002-audit-and-event-strategy.md)（事务内审计 + 因果链）、[ADR 0003](0003-durable-task-and-outbox-boundary.md)（durable tasks / outbox）、[ADR 0005](0005-auto-payments.md)（自动收付款 + 可插拔 provider）

## Context

当前会员**入会**有两条路径,且都是**一次性**:

- **人工审核**（v0.1）：扫码 → 上传截图 → 管理员 approve → `grantMembership`。
- **一次性自动**（v0.2 / ADR 0005）：Stripe 托管 Checkout（`mode=payment`）→ webhook `paid` → 与人工 approve **同一** grant 路径。

会员模型本身是 ADR 0001 的**叠加时间窗 + 存储态**：`grantMembership` 在已有 active 会员上**顺延 `endsAt`**；`memberships.status ∈ {active,suspended,revoked}`；`getActiveLevel` 按 `endsAt > now` 判定。

缺口：**没有经常性会员（recurring）**。「membership」的本质是按周期自动续订——创作者要可预期的经常性收入,粉丝要无感续费。现状每期都要重新走一次完整入会流。

**owner 决策（2026-06-20）**：

1. **三种入会方式并存**：Stripe 自动续费 + 人工审核 + 一次性,统一会员生命周期。
2. **首版范围 = Stripe Subscriptions（自动续费）+ 手动周期提醒（无卡地区:到期前邮件提醒、人工再付）**,但**架构要留足扩展性**,后期好接入别的 provider 的周期扣款。

最危险的点仍是「钱」：续费 webhook 可重放 / 乱序 / 伪造;扣款失败要有宽限与降级;退款 / 拒付要联动撤销**对应那一期**的会员;绝不把卡号落到本应用。

## Decision

### 1. Core 建立 provider 无关的「订阅」概念；续费 = 复用叠加时间窗

新增 `subscriptions` 表（**provider 无关**,订阅是 Core 资产,provider 只是「续费来源」）：

```
subscriptions(
  id, user_id, tier_id,
  status text enum: active | past_due | canceled | expired,
  provider text NULL,              -- 'stripe' | NULL（NULL = 手动周期提醒）
  provider_subscription_ref text NULL,   -- Stripe subscription id（provider 非空时）
  current_period_ends_at timestamptz NULL,
  cancel_at_period_end boolean default false,
  canceled_at timestamptz NULL,
  created_at, updated_at,
  version integer            -- 乐观锁，与会员同范式
)
```

- **续费不发明新会员状态**：每次成功续费 = 调用现有 `grantMembership`/`extendMembership`,给该用户**叠加一个周期**（`tier.durationDays`）。完全沿用 ADR 0001。
- 「订阅」与「会员」解耦：subscription 记录「续费意图与来源」,membership 记录「实际有效期」。订阅失效 → 不再续 → 会员自然到期（`endsAt` 过 → `getActiveLevel` 归零）。
- 新增 provider（支付宝周期 / PayPal）= 实现 provider 侧 + **复用同一 Core 续费路径**,不动会员模型。

### 2. `PaymentProvider` 抽象增加**可选** recurring capability（不强制）

`PaymentProvider`（`src/modules/payment/providers/`）新增**可选**方法 + 归一化事件,首版仅 Stripe 实现：

```ts
interface PaymentProvider {
  // …现有 createCheckout / parseWebhook / … 不变
  createSubscriptionCheckout?(input: {
    subscriptionRef: string;        // 本地 subscription id（幂等/回填用）
    userId: string; tierId: string;
    priceRef: string;               // provider 侧周期价格标识（见 D4）
    successUrl: string; cancelUrl: string;
  }): Promise<{ redirectUrl: string; providerRef: string }>;
  cancelSubscription?(providerSubscriptionRef: string, opts: { atPeriodEnd: boolean }): Promise<void>;
}
```

`parseWebhook` 的 `NormalizedPaymentEvent` 增加周期事件类型：

```ts
| { type: "subscription_renewed"; providerSubscriptionRef; providerEventId; amountMinor; currency; paymentRef; periodEndsAt }
| { type: "subscription_payment_failed"; providerSubscriptionRef; providerEventId }
| { type: "subscription_canceled"; providerSubscriptionRef; providerEventId }
| { type: "subscription_activated"; providerSubscriptionRef; providerEventId; periodEndsAt }
```

- **不能续费的 provider 不实现这些方法** → 优雅降级（保持「首版只接 Stripe,其他留接口」）。
- **手动周期提醒**（`provider=NULL`）不走 provider 扣款,而是 Core 调度的提醒（见 D5）。

### 3. 复用 `payment_requests` 作为「每一期一笔付款」的统一载体

每一次成功续费（无论自动还是手动）最终都生成 / 对应一条 `payment_request`,**走与一次性 approve 完全相同的 grant 事务**：

- Stripe 续费：`invoice.paid` → 归一化 `subscription_renewed` → 事务内创建 `payment_request(flow='auto', provider='stripe', status='approved', amount/currency, 关联 subscription)` + `grantMembership(tx, source='payment_auto')` + `recordAudit(tx, action='subscription_renewed', causationId=event)` + `enqueueTask(tx, 续费成功邮件)`。
- 手动续费：提醒邮件 → 粉丝走**现有人工审核或一次性 Stripe** 再付一期 → 已有路径正常 `grantMembership`。
- **退款 / 拒付**：仍复用 ADR 0005/#49 的 reverse 路径,撤销**对应那一期** payment_request 开通的会员叠加（`granted_membership_id`）。
- `payment_requests` 增列 `subscription_id uuid NULL`(关联订阅)、`kind`/`reason` 区分「首期 / 续费」(或复用 note);**幂等仍靠 `provider_event_id` 唯一约束**。

> 好处：审计 / 对账 / 反转 / 幂等 / outbox **全部复用** ADR 0002/0005/#49 现有机制,不另起炉灶。

### 4. Stripe Subscriptions 映射

- **tier 增 `stripe_price_id text NULL`**：只有「可订阅」的 tier 需要,指向 Stripe 预建的 **recurring Price**(在 tier 编辑 / 配置中心填入)。预建优于运行时动态建价(可控、避免重复建价、币种/周期由 Stripe 侧固定)。
- **开通**：Stripe Checkout `mode='subscription'` → 成功后 webhook `customer.subscription.created`（→ `subscription_activated`）+ 首期 `invoice.paid`（→ `subscription_renewed`）→ 创建本地 subscription + 首期 grant。
- **续费**：后续 `invoice.paid` → `subscription_renewed` → 叠加一期。
- **扣款失败**：`invoice.payment_failed` → `subscription_payment_failed` → 本地 subscription `status='past_due'`;**依赖 Stripe 自带 dunning（重试）**,Stripe 重试成功再发 `invoice.paid`。宽限期内会员**保持有效到当前 `endsAt`**;Stripe 最终放弃 → `customer.subscription.deleted` → `subscription_canceled` → 本地 `status='canceled'`,会员到期自然失效。
- **取消**：默认 `cancel_at_period_end=true`（用到当前期末）；webhook `customer.subscription.deleted` → `status='canceled'`/`expired`。立即取消为可选项(不退已用周期)。

### 5. 手动周期提醒（无卡地区,半自动续费）

- 不是 provider 自动扣款。一个 `provider=NULL` 的 subscription 表示「希望按期续、但靠提醒 + 人工付款」。
- Core 用 **durable task** 在会员临近到期（`current_period_ends_at` / membership `endsAt` 前 N 天,N 可配）调度 `subscription.renewal_reminder` → 发提醒邮件（复用 outbox + mail i18n）→ 粉丝走现有入会流再付一期 → 正常 `grantMembership`。
- 续费成功后重排下一次提醒;会员到期未续 → 自然失效。
- 这是「自动提醒 + 手动付款」,给无卡用户**经常性会员**体验,且零新增 provider。

### 6. webhook 幂等 + 安全（碰钱红线,复用 ADR 0005/#49）

- **绝不接触卡号 / 敏感支付数据**：一律 Stripe 托管;本应用只存 `provider_subscription_ref` / `provider_event_id` / 归一化结果。
- **幂等**：每个 `provider_event_id` 唯一约束;重复事件 → no-op 200。续费 / 乱序 / 重放安全。
- **并发守卫**：续费 grant 用条件更新 + `provider_event_id` 去重,杜绝重复叠加。
- **reversal-first**：同 #49——若反转先到,后到的续费 paid 不得开通。
- **金额校验**：续费金额与 tier 结构化价一致才接受。
- 验签密钥走配置中心加密;不入日志 / 审计。

### 7. 三种来源统一会员生命周期,互不互斥

- 人工 / 一次性 / 订阅续费**最终都调用** `grantMembership`/`extendMembership`(叠加时间窗),会员态统一。
- 一个用户可同时有 active subscription + 历史一次性叠加;`endsAt` 取叠加结果。
- tier 用 `purchase_enabled` 控一次性;**「可订阅」由 `stripe_price_id` 是否存在判定**(或新增 `subscription_enabled`,二选一,见 handoff)。

### 8. 后台 / 用户侧

- 后台:订阅列表(用户 / tier / 状态 / 下次续费 / provider)+ 取消;手动提醒订阅可见其下次提醒时间。
- 用户 `me`:看订阅状态 + 取消(`cancel_at_period_end`)。

## Alternatives

- **不建 `subscriptions` 表,纯查 Stripe**：否决。失去 provider 无关性,手动提醒无处挂,对账 / 后台难。
- **续费另起会员状态机**：否决。违背 ADR 0001 叠加时间窗;复用 `extendMembership` 最简、与现有审计 / 反转一致。
- **运行时动态建 Stripe Price**：否决(首版)。预建 `stripe_price_id` 更可控、避免重复建价;后续需要再评估。
- **订阅完全独立于 `payment_requests`**：否决。审计 / 反转 / 幂等 / outbox 要复用,每期一笔 payment_request 最自然。
- **首版就接多 provider 周期扣款**：否决。owner 选 Stripe + 手动提醒;provider 抽象留好可选 recurring 方法,后续增量接入。

## Consequences

- ✅ 真正的会员续费(Stripe 自动 + 无卡地区半自动),经常性收入,1.0 核心闭环补齐。
- ✅ 复用会员叠加 + 审计 + outbox + 反转,增量可控;新 provider 易接入(Core 续费路径不变)。
- ⚠️ **有 schema 迁移**：新增 `subscriptions` 表、`payment_requests.subscription_id`、`membership_tiers.stripe_price_id`。
- ⚠️ Stripe webhook 事件集扩大(`customer.subscription.*`、`invoice.paid`、`invoice.payment_failed`),需幂等 / 乱序 / 宽限处理 + 针对性测试。
- ⚠️ 宽限期 / dunning 依赖 Stripe 重试;取消语义(period end vs immediate)需在 UI / 文档讲清。
- ⚠️ 退款 / 拒付反转要对应到**正确那一期**的会员叠加(复用 `granted_membership_id`)。
- ⚠️ 手动提醒依赖 durable task 调度准确 + 邮件送达;到期前窗口与重排需测试。
- ⚠️ 与一次性 / 人工并存,需回归测试三者叠加后的 `endsAt` 与权限正确。

## 待确认（评审时定）

1. 「可订阅」判定:用 `stripe_price_id` 是否存在,还是新增显式 `subscription_enabled` 列?(倾向前者,少一列)
2. 取消默认:`cancel_at_period_end`(用到期末,推荐)vs 立即取消。
3. 手动提醒提前天数 N 默认值(如 7 天)与是否可配。
4. 宽限期是否在 Core 额外加「past_due 期间会员仍有效」的显式窗口,还是完全交给 Stripe dunning + 自然 `endsAt`。
