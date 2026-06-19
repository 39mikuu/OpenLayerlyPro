# 交接：自动收付款 #2 — 退款 / 拒付联动撤销会员

> 给执行 agent 的自包含实现说明。前置依赖：切片 #1（Stripe 一次性付款）已经在 `main`，包括 `createAutoCheckout`、`confirmAutoPayment`、`expireAutoPayment`、Stripe webhook 路由和管理员手动 `reversePaymentApproval`。架构决策见 [ADR 0005](../adr/0005-auto-payments.md) §6。
>
> 开工前创建独立 Issue，例如 `feat(payments): refund/dispute auto-reversal`，实现 PR 关联该 Issue，并保持 Draft 直到真实 PostgreSQL 集成测试与完整 CI 全绿。

本切片处理：Stripe 全额退款或拒付创建事件 → 定位付款请求 → 原子写入 `payment_requests.status='reversed'` → 如会员已开通则复用 #6 的撤销核心 revoke 对应会员 → 写审计因果链与 durable outbox 通知。

## 0. 红线

1. **浏览器 redirect 永远不是付款或退款权威来源**，只处理已验签 Stripe webhook。
2. **事件顺序不可信**。退款/拒付可能先于 `checkout.session.completed` 到达；不能只抛错等待未来重试，必须把已确认的反转事实持久化，使后到的 paid 事件绝不能开通会员。
3. `provider_event_id` 已用于 paid/expired 事件；退款/拒付必须使用独立的 `reversal_event_id`。
4. `payment_intent → payment_request` 必须是数据库层一对一映射，不能普通索引后 `.limit(1)`。
5. 同一 Stripe 账户可能被其他产品共用；查到 Checkout Session 不等于属于 OpenLayerlyPro，必须校验归属标记或现有 DB 映射。
6. Stripe API 网络调用不得放在持有数据库事务或行锁的代码段内。
7. 管理员手动反转的公开行为、错误码和旧回归测试不得改变。

## 1. 当前实现中可复用的部分

- `src/modules/payment/index.ts`
  - `confirmAutoPayment(providerId, event)`：paid 事件幂等确认、`FOR UPDATE`、条件更新、grant、审计和 outbox。
  - `reversePaymentApproval(requestId, reviewerId, reason)`：管理员手动 `approved → reversed`、grant-link 守卫、会员 revoke 与审计。
  - `finalizeApprovedPayment(tx, row, context)`：批准后的会员开通与邮件入队。
- `src/modules/payment/providers/index.ts`：`PaymentProvider` 与 `NormalizedPaymentEvent`。
- `src/modules/payment/providers/stripe.ts`：Checkout 创建、webhook 验签与 paid/expired 解析。
- `src/modules/membership/index.ts`：`revokeMembership(...)`。
- `src/modules/audit`：`recordAudit(...)`。
- `src/modules/tasks`：事务内 `enqueueTask(...)`。

## 2. 锁定决策

| # | 决策 |
|---|---|
| D1 | 沿用现有 `payment_requests.status='reversed'`，不新增付款状态。 |
| D2 | 新增 `provider_payment_ref`（Stripe `payment_intent`）与 `reversal_event_id`；两者均使用 **provider-scoped partial unique index**。 |
| D3 | refund 与 dispute 使用独立归一化事件类型、独立审计动作，但共用同一自动反转服务。 |
| D4 | 只处理全额退款与 `charge.dispute.created`；部分退款 ignored。dispute won 不自动复权。 |
| D5 | 新 Checkout 写入 `metadata.app='openlayerlypro'`；历史 Checkout 仍可通过 `provider_ref=session.id` 命中。 |
| D6 | 已确认属于本应用的 reversal 命中 `pending_payment` 时，必须原子写成 `reversed` 并返回 200；后到 paid 事件只能记录幂等信息，禁止 grant。 |
| D7 | paid 已先完成时，reversal 执行 `approved → reversed` 并撤销 `granted_membership_id` 对应会员。 |
| D8 | 找不到 DB 行但 Session 明确 `owned=true` 时返回可重试错误；外部事件或无 Checkout Session 的事件返回 200 ignored。 |

## 3. Schema 与迁移

`src/db/schema/index.ts` 的 `payment_requests` 新增：

```ts
providerPaymentRef: text("provider_payment_ref"), // Stripe payment_intent
reversalEventId: text("reversal_event_id"), // refund/dispute Stripe event id
```

使用 provider-scoped partial unique index，避免未来不同 provider 的 ID 命名空间碰撞：

```ts
uniqueIndex("payment_requests_provider_payment_ref_unique")
  .on(table.provider, table.providerPaymentRef)
  .where(
    sql`${table.provider} is not null and ${table.providerPaymentRef} is not null`,
  ),

uniqueIndex("payment_requests_reversal_event_id_unique")
  .on(table.provider, table.reversalEventId)
  .where(
    sql`${table.provider} is not null and ${table.reversalEventId} is not null`,
  ),
```

生成增量迁移：

```bash
pnpm exec drizzle-kit generate
```

迁移只加列与索引，不全表调用 Stripe 回填。历史自动付款在首次退款/拒付时通过 Checkout Session lazy backfill `provider_payment_ref`。

## 4. Provider 契约

`src/modules/payment/providers/index.ts`：

```ts
export type RefundedPaymentEvent = {
  type: "refunded";
  paymentRef: string;
  providerEventId: string;
};

export type DisputedPaymentEvent = {
  type: "disputed";
  paymentRef: string;
  providerEventId: string;
};

export type NormalizedPaymentEvent =
  | PaidPaymentEvent
  | ExpiredPaymentEvent
  | RefundedPaymentEvent
  | DisputedPaymentEvent
  | { type: "ignored"; providerEventId: string };
```

`PaidPaymentEvent` 增加：

```ts
paymentRef: string; // Stripe payment_intent
```

`PaymentProvider` 增加：

```ts
resolveCheckoutByPaymentIntent(paymentRef: string): Promise<
  | {
      providerRef: string;
      requestId?: string;
      owned: boolean;
    }
  | null
>;
```

## 5. Stripe 适配器

### 5.1 Checkout 归属标记

创建 Checkout Session 时保留 `requestId` 并增加应用标记：

```ts
metadata: {
  requestId: input.requestId,
  app: "openlayerlypro",
},
```

历史 Session 没有 `app` 标记时，只要 `provider_ref=session.id` 能命中 DB 行，仍视为本应用历史付款。

### 5.2 paid 事件

`checkout.session.completed` 的 `session.payment_intent` 必须存在；标准化为 `PaidPaymentEvent.paymentRef`。同步卡支付缺少 PaymentIntent 属于本应用事件结构异常，返回非 2xx。

### 5.3 全额退款

```ts
if (event.type === "charge.refunded") {
  const charge = event.data.object as Stripe.Charge;

  if (!charge.refunded || charge.amount_refunded !== charge.amount) {
    return { type: "ignored", providerEventId: event.id };
  }

  // Charge.payment_intent 合法可空。同一 Stripe 账户中的旧 charge 或
  // 非 Checkout 集成无法映射到本应用，必须 ignored，不能永久重试。
  if (!charge.payment_intent) {
    return { type: "ignored", providerEventId: event.id };
  }

  return {
    type: "refunded",
    paymentRef:
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent.id,
    providerEventId: event.id,
  };
}
```

### 5.4 拒付创建

```ts
if (event.type === "charge.dispute.created") {
  const dispute = event.data.object as Stripe.Dispute;

  if (!dispute.payment_intent) {
    return { type: "ignored", providerEventId: event.id };
  }

  return {
    type: "disputed",
    paymentRef:
      typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : dispute.payment_intent.id,
    providerEventId: event.id,
  };
}
```

### 5.5 PaymentIntent 反查

```ts
async resolveCheckoutByPaymentIntent(paymentRef: string) {
  const list = await this.client.checkout.sessions.list({
    payment_intent: paymentRef,
    limit: 1,
  });
  const session = list.data[0];
  if (!session) return null;

  return {
    providerRef: session.id,
    requestId: session.metadata?.requestId || undefined,
    owned: session.metadata?.app === "openlayerlypro",
  };
}
```

## 6. `confirmAutoPayment` 必须处理 reversal-first

现有 paid 路径增加 `providerPaymentRef: event.paymentRef`。在 grant 前锁定请求并执行：

1. 校验 provider、Checkout Session、金额、币种与 `paymentRef` 一致性。
2. 若 `status='pending_payment'` 且没有 reversal，沿用现有批准路径。
3. 若 `status='reversed'`：
   - **绝不 grant 会员**；
   - 如果 `provider_event_id` 为空，则只回写 paid event ID 与一致的 `provider_payment_ref`，用于重放幂等；
   - 如果已是同一 paid event，直接 no-op；
   - 如果 paymentRef 冲突，抛错并回滚。
4. 其他终态继续沿用现有幂等/冲突处理。

必须保证以下顺序成立：

```text
reversal webhook → pending_payment 变 reversed → paid webhook 后到 → 仍为 reversed，会员从未 active
```

## 7. 共享的已批准付款反转核心

从 `reversePaymentApproval` 抽出只针对 **已批准且存在 grant link** 的 helper：

```ts
async function applyApprovedPaymentReversal(
  tx: DbClient,
  reversed: PaymentRequest,
  context: {
    actor: { type: "admin"; id: string } | { type: "system"; id: null };
    reason: string;
    auditAction:
      | "reverse"
      | "payment_auto_refunded"
      | "payment_auto_disputed";
    correlationId: string;
    auditAfterExtra?: Record<string, unknown>;
  },
): Promise<void> {
  if (!reversed.grantedMembershipId) {
    throw new ApiError(409, "paymentGrantLinkMissing");
  }

  const reverseAudit = await recordAudit(tx, {
    entityType: "payment_request",
    entityId: reversed.id,
    action: context.auditAction,
    actor: context.actor,
    reason: context.reason,
    before: { status: "approved" },
    after: { status: "reversed", ...(context.auditAfterExtra ?? {}) },
    correlationId: context.correlationId,
  });

  const membership = await loadGrantedMembershipForUpdate(
    tx,
    reversed.grantedMembershipId,
  );

  if (membership.status !== "revoked") {
    await revokeMembership(
      membership.id,
      {
        reason: context.reason,
        actor: context.actor,
        expectedVersion: membership.version,
        correlationId: context.correlationId,
        causationId: reverseAudit.id,
      },
      tx,
    );
  }
}
```

管理员 `reversePaymentApproval` 仍先执行 `approved → reversed` 条件更新，再调用该 helper。对外行为、审计动作 `reverse`、错误码和旧测试不变。

## 8. `reverseAutoPayment`

### 8.1 不要在事务内调用 Stripe

先进行无锁快查；确实缺少 `provider_payment_ref` 映射时，在数据库事务外调用 `resolveCheckoutByPaymentIntent`。随后进入事务，重新检查幂等、重新查询并 `FOR UPDATE` 锁行。事务中的查询结果才是最终依据。

### 8.2 状态处理

事务内按以下顺序：

1. 以 `(provider, reversal_event_id)` 检查事件幂等。
2. 以 `(provider, provider_payment_ref)` 快查并锁行。
3. 未命中时使用事务外得到的 Session 信息，按 `provider_ref` 或合法 `requestId` 查找并锁行。
4. 无 DB 行：
   - 无 Session 或 `owned=false`：外部事件，200 ignored；
   - `owned=true`：本应用数据尚未就绪或损坏，返回 503 让 Stripe 重试并触发告警。
5. 对历史行 lazy backfill `provider_payment_ref`，冲突由 unique index 阻止。
6. 按状态执行：

#### `reversed`

直接 200 no-op。一个请求只反转一次；后续不同 refund/dispute 事件不得重复修改会员。

#### `pending_payment`

**不能只抛错等待 Stripe 重试。** 原子执行：

```ts
const [reversed] = await tx
  .update(paymentRequests)
  .set({
    status: "reversed",
    providerPaymentRef: event.paymentRef,
    reversalEventId: event.providerEventId,
    reviewNote: reasonText,
    reviewedAt: now,
    updatedAt: now,
  })
  .where(
    and(
      eq(paymentRequests.id, request.id),
      eq(paymentRequests.status, "pending_payment"),
    ),
  )
  .returning();
```

成功后写 `payment_auto_refunded` 或 `payment_auto_disputed` 审计：

```ts
before: { status: "pending_payment" },
after: {
  status: "reversed",
  provider: providerId,
  paymentRef: event.paymentRef,
  reversalEventId: event.providerEventId,
  kind: event.type,
},
actor: { type: "system", id: null },
```

此时尚未 grant 会员，因此**不调用** `applyApprovedPaymentReversal`。事务提交后返回 200。后到 paid webhook 由 §6 拦截，不能开通会员。

#### `approved`

条件更新 `approved → reversed`，同时写 `providerPaymentRef`、`reversalEventId` 和 review metadata；随后调用 `applyApprovedPaymentReversal` 撤销关联会员并写因果审计。

#### `rejected` / `cancelled`

没有有效会员可撤销，重试无法修复。记录不含敏感信息的结构化 warning 后返回 200 no-op，避免 Stripe 永久重试。不得误撤其他会员。

## 9. Webhook 路由

```ts
if (event.type === "paid") {
  await confirmAutoPayment("stripe", event);
}
if (event.type === "expired") {
  await expireAutoPayment("stripe", event);
}
if (event.type === "refunded" || event.type === "disputed") {
  await reverseAutoPayment("stripe", event);
}
```

只有以下瞬时/需人工修复情形返回非 2xx：

- 明确 `owned=true` 但 DB 行不存在；
- Stripe API 临时失败；
- approved 行缺少 grant link；
- unique/paymentRef 冲突或数据库失败。

Stripe Dashboard webhook 必须勾选：

- `checkout.session.completed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`

同步更新 `docs/admin/payment-review.md` 与 Stripe 配置说明。

## 10. 用户通知

自动反转会在无管理员操作的情况下停止访问，建议作为本切片必做：

- 新增 outbox 邮件模板 `membership_revoked`；
- en/zh/ja 文案使用中性表述，例如“您的会员访问已停用”；
- 不向用户暴露内部事件 ID、拒付原因或敏感 provider 数据；
- dedupe key 使用付款请求 ID，例如 `email:membership_revoked:<requestId>`；
- pending_payment reversal 尚未开通过会员，可发送“付款已取消/退款”类通知，或在 PR 中明确暂不发送；不得错误发送“会员被撤销”。

## 11. 测试

### Provider 单测

- 全额 `charge.refunded` → `refunded`。
- 部分退款 → `ignored`。
- `charge.dispute.created` → `disputed`。
- refund/dispute 缺少 `payment_intent` → `ignored`，不是 422。
- paid 事件包含 `paymentRef`。
- Session 反查分别覆盖 `owned=true`、`owned=false`、无 Session。

### 真实 PostgreSQL 集成测试

必须覆盖：

1. paid 先到：`pending_payment → approved`，会员 active；随后 refund → request reversed、会员 revoked、因果审计完整。
2. dispute 路径使用 `payment_auto_disputed`，与 refund 审计动作分离。
3. **reversal 先到**：
   - request 原为 `pending_payment`；
   - reversal 在一个事务内把它改成 `reversed` 并写审计；
   - 返回 200，不依赖未来重试；
   - paid 后到不得 grant 会员；
   - 重放 paid/reversal 均幂等。
4. paid 与 reversal 并发：最终只能是 `reversed`；如果曾 grant，则关联会员最终 revoked；不存在错误的其他会员变更。
5. 同一 `reversal_event_id` 重放只处理一次。
6. 同一 `provider_payment_ref` 不可关联两个同 provider 请求。
7. 不同 provider 可使用相同外部 ID，不发生跨 provider 冲突。
8. 外部 PaymentIntent：无 Session或 `owned=false` → 200 no-op。
9. `owned=true` 但 DB 无行 → 可重试错误。
10. 历史 approved 行只有 `provider_ref=session.id` → lazy backfill 后成功反转。
11. 管理员已手动 reverse 后 webhook 到达 → no-op。
12. approved 但 `granted_membership_id` 缺失 → 事务回滚，不误撤其他会员。
13. `reversePaymentApproval` 全部旧回归测试逐条通过。
14. webhook 伪造签名 → 401。

## 12. 提交前验证

```bash
pnpm lint
pnpm format:check
pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator
pnpm build
```

## 13. 实现 PR 验收清单

- [ ] 两个新增字段与 provider-scoped partial unique index 已生成迁移
- [ ] Checkout metadata 带 `app=openlayerlypro`
- [ ] paid 写入 `provider_payment_ref`
- [ ] refund/dispute 缺失 PaymentIntent 安全 ignored
- [ ] Session 反查可区分本应用与同账号外部集成
- [ ] Stripe API 调用不在数据库事务/行锁内
- [ ] pending reversal 原子持久化为 `reversed`
- [ ] paid 后到不会开通会员
- [ ] approved reversal 复用管理员反转核心并 revoke 精确 grant link
- [ ] refund/dispute 审计动作分离，actor=system，causation 完整
- [ ] 重放、乱序和并发测试全绿
- [ ] 管理员手动反转行为与旧测试不变
- [ ] Stripe Dashboard 与管理员文档已更新
- [ ] 不记录或输出密钥、签名、完整 Stripe payload 等敏感信息

## 不在本切片

- dispute won 后自动复权
- 部分退款按比例处理
- 自动 reconciliation / 告警面板
- 订阅续费与失败扣款联动
- 支付宝、微信等其他 provider 的退款实现
