# ADR 0009：周期性会员（订阅自动续费 + 手动周期提醒）

- **Status**：Proposed ▶（2026-06-20；评审锁定后转 Accepted）
- **相关 issue**：v1.0 会员续费（待建 issue）
- **依赖**：[ADR 0001](0001-membership-lifecycle-model.md)（会员生命周期：叠加时间窗 + 存储态）、[ADR 0002](0002-audit-and-event-strategy.md)（事务内审计 + 因果链）、[ADR 0003](0003-durable-task-and-outbox-boundary.md)（durable tasks / outbox）、[ADR 0005](0005-auto-payments.md)（自动收付款 + 可插拔 provider）

## Context

当前会员**入会**有两条路径,都是**一次性**:人工审核（v0.1）、一次性自动（v0.2 / ADR 0005，Stripe `mode=payment`）。会员模型是 ADR 0001 的**叠加时间窗 + 存储态**：`grantMembership` 在已有 active 会员上**顺延同一行的 `endsAt`**；`memberships.status ∈ {active,suspended,revoked}`。

缺口：**没有经常性会员**。owner 决策（2026-06-20）：① 三种入会方式并存；② 首版 = Stripe Subscriptions（自动续费）+ 手动周期提醒（无卡地区），架构留足 provider 扩展性。

**评审（PR #59）暴露的硬约束**——本 ADR 必须解决,否则不实现：

- **B1 按期反转与现模型不兼容**：现状多笔付款叠加到**同一** membership 行,反转走 `revokeMembership` **吊销整行**,无法只撤销某一期。「复用 #49 无需新代码」不成立。
- **B2 webhook 不能假设顺序**：Stripe `invoice.paid` 可能早于 `customer.subscription.created` 到达。
- **B3 固定 `durationDays` 不等于 Stripe 计费周期**：月度周期天数不定（月末、2 月、闰年、billing anchor、试用、proration），用固定天数会与 Stripe `current_period_end` 漂移。
- **B4 只存「最近 event id」不足以幂等/防乱序**：非付款事件（activated/failed/canceled）也要幂等,旧事件重放不得覆盖新状态。
- **B5 订阅聚合状态不能否决某笔已付 invoice**：取消/删除与付款事件可能乱序,按聚合状态拦截会「收了钱却不给权益」。

最危险的仍是「钱」：续费 webhook 可重放/乱序/伪造;退款/拒付要联动撤销**对应那一期**；绝不把卡号落到本应用。

## Decision

### 1. 权益 = 不可变 grant 账本（解决 B1/B3/B5,统一模型）

新增**不可变** `membership_grants` 账本：**每一笔授予都是一行,可独立反转**,有效权益由所有未反转 grant **重算**得出。

```
membership_grants(
  id, user_id, tier_id,
  source text enum: manual | payment_review | payment_auto | subscription | gift | external,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,     -- 该笔授予覆盖的权益窗口（见 §4：订阅用 Stripe 实际周期，非固定天数）
  payment_request_id uuid NULL,          -- 关联那一笔付款（可反转的因果锚点）
  subscription_id uuid NULL,
  reversed_at timestamptz NULL,
  reversal_reason text NULL,
  created_at, ...
)
```

- **有效会员 = 由未反转 grant 重算的派生投影**：`memberships` 行降级为**派生缓存**（或读时计算）。
  - `getActiveLevel` / 有效 `endsAt`：取所有未反转 grant 在各 tier 上**叠加**后的覆盖区间（沿用 ADR 0001「叠加时间窗」语义,只是从「一个可变 endsAt」改为「一组不可变 grant 的并/和」）。
  - **反转某一笔** = 给该 grant 置 `reversed_at` → **重算**有效 `endsAt`/level。这样退款/拒付只撤销那一期,**保留**其他期、手动、tier 变更、其他来源。
- **所有来源统一写账本**：人工 / 一次性 / 订阅续费 / gift 都写一行 `membership_grants`;`grantMembership` 改为「追加一笔 grant + 重算投影」。一次性/人工的反转也因此**从「吊销整行」升级为「撤销那一笔」**（顺带修正现状的粗粒度反转）。
- **叠加重算规则**（明确,供实现 + 测试）：同一用户对某 tier 的有效到期 = 从「当前 active 基准」起,按未反转 grant 的 `period` **连续顺延**;反转中间一笔时按文档化规则重算（推荐：重算为「未反转 grant 时长之和从基准顺延」,即移除该笔时长,后续不留洞——见 handoff §权益重算）。

> 这是对 ADR 0001 的**细化/扩展**(不是推翻):时间窗叠加语义不变,只是把「一个可变 endsAt」显式化为「不可变 grant 账本 + 派生投影」,以支持按笔反转。需要把现有 membership 迁移/前向兼容(见 Consequences)。

### 2. Core 建立 provider 无关的「订阅」概念

新增 provider 无关 `subscriptions` 表（订阅是 Core 资产,provider 只是「续费来源」）：

```
subscriptions(
  id, user_id, tier_id,
  status text enum: pending | active | past_due | canceled | expired,
  provider text NULL,                    -- 'stripe' | NULL（NULL = 手动周期提醒）
  provider_subscription_ref text NULL,
  current_period_ends_at timestamptz NULL,
  cancel_at_period_end boolean default false,
  canceled_at timestamptz NULL,
  status_event_at timestamptz NULL,      -- 最近一次驱动 status 的 provider 事件时间（防乱序，见 §5）
  version integer default 0,
  created_at, updated_at
)
-- UNIQUE(provider, provider_subscription_ref) WHERE provider_subscription_ref IS NOT NULL
```

- 订阅记录「续费意图与来源」,grant 账本记录「实际权益」。订阅失效 → 不再续 → 会员按账本自然到期。
- 新增 provider（支付宝周期 / PayPal）= 实现 provider 侧 + 复用同一 Core 续费路径,不动权益模型。

### 3. `PaymentProvider` 抽象增加**可选** recurring capability

`PaymentProvider` 新增**可选** `createSubscriptionCheckout?` / `cancelSubscription?`;`NormalizedPaymentEvent` 增加 `subscription_activated` / `subscription_renewed`(带**invoice 实际 period.start/period.end**)/ `subscription_payment_failed` / `subscription_canceled`,且每个事件都带 **provider 事件 id + provider 事件时间**(见 §5)。不能续费的 provider 不实现这些方法 → 优雅降级（首版仅 Stripe）。

### 4. Stripe 映射：实际周期 + 顺序无关的开通/恢复（解决 B2/B3）

- **tier 增 `stripe_price_id`**：指向 Stripe 预建 recurring Price;「可订阅」由其是否存在判定。
- **权益窗口用 invoice 实际周期,不用固定天数**(B3)：每期 grant 的 `period_start/period_end` = `invoice.lines[].period.start/end`（Stripe 权威周期），与 Stripe `current_period_end` 对齐,杜绝月末/2 月/闰年/anchor 漂移。
- **顺序无关的开通/恢复**(B2)：
  1. **Checkout 之前先建本地 `subscription`**（`status='pending'`,provider='stripe',无 ref）。
  2. 把**本地 subscription id 写进 Stripe metadata**（Checkout / Subscription / Invoice 可恢复字段）+ 归属标记 `app='openlayerlypro'`。
  3. `invoice.paid` 处理时**按 metadata/`provider_subscription_ref` upsert 恢复**本地 subscription,**不要求** `customer.subscription.created` 先到。
  4. **owned-but-unresolved**（确属本应用、但本地 subscription 尚不可解析）**绝不当永久 no-op**：返回**可重试错误**或落库待处理,靠 Stripe 重试/补偿收敛（同 ADR 0005「ours-but-not-ready → retry」语义）。

### 5. webhook 幂等 + 防乱序 = provider 事件账本（解决 B4/B5）

新增 `payment_provider_events` 事件账本（**所有** provider 事件,不只是产生付款的）：

```
payment_provider_events(
  id, provider text, provider_event_id text,
  event_type text, object_ref text,                 -- 如 subscription/invoice id
  provider_created_at timestamptz,                   -- provider 侧事件时间（单调依据）
  status text enum: received | processed | failed,
  processed_at timestamptz NULL, error text NULL,
  created_at
)
-- UNIQUE(provider, provider_event_id)
```

- **幂等**：每个事件先 upsert 进账本(唯一约束);已 `processed` → no-op 200。付款类继续额外用 `payment_requests.provider_event_id` 守卫。
- **防乱序**(B4)：subscription 状态转移用 `provider_created_at`（或等价单调版本）**拒绝过期事件**——`failed → paid → 旧 failed 重放` 中,旧 failed 的事件时间早于已记录的 `status_event_at`,**忽略**,不回退到 past_due。
- **按 invoice 决策,不按聚合状态**(B5)：是否对某 invoice 开通,**只看该 invoice/payment 自身状态**(是否被退款/拒付/反转),**不**因 subscription 当前是 `canceled` 就拒绝一笔已成功的 `invoice.paid`(取消与付款可乱序;period-end 取消可能早于已收款的 invoice 到达)。只有**那一笔** invoice 被 refunded/disputed/reversed 才阻止/撤销其 grant。

### 6. 续费 = 追加一笔 grant + 重算（复用审计/outbox/反转）

每期成功（自动或手动）= 事务内：写 `payment_request(flow=auto/manual, status=approved, subscription_id, provider_event_id, provider_payment_ref, amount/currency)` + **追加一笔 `membership_grant`(period 来自 Stripe invoice)** + **重算会员投影** + `recordAudit(action='subscription_renewed', causationId=event)` + `enqueueTask(续费邮件)`。

- **退款/拒付**：复用 #49 入口,但反转动作改为**反转那一笔 grant**(按 `payment_request → membership_grant`),再重算;**不**吊销整行会员。
- **金额校验**：续费金额与 tier 结构化价一致才接受。
- **绝不接触卡号**;验签密钥走配置中心加密,不入日志/审计。

### 7. 手动周期提醒（无卡地区,半自动）

`provider=NULL` 的 subscription + durable task `subscription.renewal_reminder`：会员临近到期（前 N 天,可配,有上下限）发提醒邮件 → 粉丝走**现有人工审核或一次性 Stripe** 再付一期 → 正常追加一笔 grant → 重排下次提醒。手动 grant 的 period 用 `tier.durationDays`（无 Stripe 周期可循）。

### 8. 三种来源并存 + 后台/用户侧

人工/一次性/订阅续费都**追加 grant + 重算**,会员态统一。tier 用 `purchase_enabled` 控一次性;`stripe_price_id` 控订阅。后台:订阅列表 + 取消;`me`:订阅状态 + 取消（默认 `cancel_at_period_end`）。

## Alternatives

- **不建 grant 账本,继续吊销整行**：否决（B1）——无法按期反转,退款误伤其他期/手动/其他来源。
- **按固定 `durationDays` 续费**：否决（B3）——与 Stripe 实际周期漂移。
- **只存最近 event id 幂等**：否决（B4）——非付款事件无幂等、旧事件覆盖新状态。
- **按 subscription 聚合状态决定是否开通**：否决（B5）——乱序下收钱不给权益。
- **要求 `subscription.created` 先于 `invoice.paid`**：否决（B2）——Stripe 不保证顺序。
- **不建 `subscriptions` 表纯查 Stripe**：否决——失 provider 无关性、手动提醒无处挂、对账难。
- **首版接多 provider 周期扣款**：否决——Stripe + 手动提醒;provider 抽象留可选 recurring 方法,后续增量。

## Consequences

- ✅ 真正的会员续费(Stripe 自动 + 无卡半自动),经常性收入,1.0 核心闭环补齐。
- ✅ **按笔可反转的权益账本**:退款/拒付只撤对应期,顺带修正现状一次性/人工的粗粒度反转。
- ✅ provider 无关订阅 + 事件账本,易接入新 provider、对账可审计。
- ⚠️ **较大 schema 迁移**：新增 `membership_grants`、`subscriptions`、`payment_provider_events`;`payment_requests.subscription_id`；`membership_tiers.stripe_price_id`。**且需把现有 memberships 迁移成 grant 账本(或前向兼容:旧行视为单笔 grant)**——这是本切片最重的一块,需谨慎设计 + 迁移测试。
- ⚠️ `grantMembership`/反转路径改为「追加 grant + 重算投影」,影响现有人工/一次性/反转(#49)代码,**必须全回归**。
- ⚠️ Stripe webhook 事件集扩大;需幂等账本 + 乱序拒绝 + 顺序无关恢复 + 按 invoice 决策 + 针对性测试(见下)。
- ⚠️ 权益重算规则(尤其反转中间一笔)需文档化 + 测试,避免留洞或多给。
- ⚠️ 手动提醒依赖 durable task 调度 + 邮件送达。

## 必须覆盖的测试（评审要求）

- `invoice.paid` **早于** `customer.subscription.created` 到达 → 首期正常开通(顺序无关恢复)。
- `customer.subscription.deleted` **早于**一笔已成功 `invoice.paid` → 该 invoice 仍开通(按 invoice 决策,不被聚合 canceled 否决)。
- `failed → paid → 旧 failed 重放` → 不回退 past_due(事件时间防乱序)。
- 三期 grant,**只退中间一期** → 其余期/手动/其他来源权益不受损(账本重算)。
- 按期反转与**人工/一次性并存**时,只撤对应那一笔。
- 月末 / 2 月·闰年 / 非默认 billing anchor 周期 → 权益窗口取 Stripe 实际 period,不漂移。
- 续费幂等(event 账本 + payment_request 双守卫)、金额校验、reversal-first。

## 待确认（评审时定）

1. 权益重算:反转中间一笔的语义——「按未反转时长之和从基准顺延」(不留洞,推荐)还是「严格保留各 grant 原始 [start,end] 区间」(可能留洞)。
2. 现有 memberships 迁移:回填成 `membership_grants` vs 旧行作为「单笔 legacy grant」前向兼容。
3. 「可订阅」判定:`stripe_price_id` 是否存在 vs 显式列。
4. 取消默认:period-end(推荐)vs 立即;手动提醒提前天数默认。
5. past_due 宽限:完全交给 Stripe dunning + 账本自然到期,还是 Core 额外显式窗口。
