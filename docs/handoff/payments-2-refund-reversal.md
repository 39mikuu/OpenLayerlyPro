# 交接：自动收付款 #2 — 退款 / 拒付联动撤销会员

> 给执行 agent 的自包含实现说明。**前置依赖:切片 #1(Stripe 一次性付款)已在 main**(`createAutoCheckout` / `confirmAutoPayment` / `expireAutoPayment` / webhook 路由 / `reversePaymentApproval` 均已合并)。落地决策见 [ADR 0005](../adr/0005-auto-payments.md) §6(Accepted)。
>
> 开工前在 GitHub 建一个 issue(如「feat(payments): refund/dispute auto-reversal」),PR 关联它。

这是自动支付的**第二个垂直切片**:Stripe 退款 / 拒付回调 → **复用 #6 的会员撤销逻辑** → 自动把对应会员 revoke + 审计因果。**零新增状态机**(沿用 `payment_requests.status='reversed'`)。

> ⚠️ **本文档已根据评审修正四个早期缺陷**(见每条 D 决策的「修正」标注):① 未匹配事件不可无差别 200;② payment_intent→request 映射必须唯一;③ 退款与 dispute 语义必须分离;④ 不能假设历史行都有回填字段。实现时务必按修正后的设计落地。

## 0. 必读 / 现状

- 切片 #1 已落地的代码(本切片直接扩展,**别重写**):
  - `src/modules/payment/index.ts`
    - `confirmAutoPayment(providerId, event)` —— 已验签事件的**幂等确认**范式(`providerEventId` 去重 + `FOR UPDATE` + 条件更新 `pending_payment→approved` + grant + 审计 + outbox)。本切片的 `reverseAutoPayment` **照抄这套幂等骨架**。
    - `reversePaymentApproval(requestId, reviewerId, reason)` —— **管理员手动**反转:条件更新 `approved→reversed` + 审计 `reverse` + `revokeMembership(tx)`,含 `paymentGrantLinkMissing` 守卫与「会员已 revoked 则跳过」判断。本切片把它的**核心反转逻辑抽成共享 helper**,管理员路径与自动退款路径都调它。
    - `finalizeApprovedPayment(tx, row, context)` —— grant + 回写 `granted_membership_id` + 邮件入队的共享 helper(参考其抽取范式)。
  - `src/modules/payment/providers/index.ts` —— `PaymentProvider` 契约 + `NormalizedPaymentEvent` 联合(`PaidPaymentEvent` / `ExpiredPaymentEvent` / `ignored`)。本切片**新增 `RefundedPaymentEvent` 与 `DisputedPaymentEvent`(分开)**。
  - `src/modules/payment/providers/stripe.ts` —— `parseWebhook` 已处理 `checkout.session.completed` / `checkout.session.expired`,并有 `getCheckoutState(providerRef)`(经 `sessions.retrieve`)。本切片**新增 `charge.refunded` / `charge.dispute.created` 分支 + `resolveCheckoutByPaymentIntent`**。
  - `src/app/api/payments/webhook/stripe/route.ts` —— 已 dispatch `paid` / `expired`。本切片**新增 `refunded` / `disputed` dispatch**。
  - `src/modules/membership/index.ts`:`revokeMembership(id, { reason, actor, expectedVersion, correlationId, causationId }, tx)`。
  - `src/modules/audit`:`recordAudit(tx, ...)`;`src/modules/tasks`:`enqueueTask(tx, ...)`。
  - `src/modules/tasks/handlers.ts` + `src/modules/mail`:邮件模板的 discriminated union + 发送函数(本切片**可选**新增 `membership_revoked` 模板,见 §7)。
- 现状关键事实(本切片设计依赖这几条):
  1. **切片 #1 的 `createCheckout` 已把 `session.id` 存进 `payment_requests.provider_ref`**,且 Checkout Session 带 `metadata.requestId`。→ 即使没有新字段,退款事件也能经 Stripe API 用 `payment_intent` 反查到 session、再回到 `provider_ref`(**这是回填/外部事件判定的基石**)。
  2. `payment_requests.provider_event_id` 是**单列 + 唯一索引**,已被 `confirmAutoPayment`(paid)或 `expireAutoPayment`(expired)占用。**退款是 `approved` 之后的第二个权威事件,不能复用该列**,需独立幂等键。
  3. **Stripe 退款/拒付事件不带 Checkout Session id**。`charge.refunded` / `charge.dispute.created` 的对象只有 `payment_intent`,**没有 `session.id`**。
  4. 一个 `payment_intent` 对应唯一一次 Checkout Session、唯一一个 request → payment_intent→request 是 **1:1**,应在 DB 层用唯一约束钉死。

## 1. 已锁定决策(动工前若有异议先提)

| # | 决策 | 理由 / 修正 |
|---|---|---|
| D1 | **退款/拒付 → 复用反转核心,撤销 `granted_membership_id` 对应会员**。沿用 `status='reversed'`,**不新增状态**。 | ADR 0005 §6;零新增状态机 |
| D2 | **新增反转事件幂等列 `reversal_event_id text` + partial uniqueIndex**(独立于 paid 占用的 `provider_event_id`)。退款与 dispute 共用此列:一个 request 只会被反转一次(refund 或 dispute 其一先到即 `reversed`,后到者撞 `approved` 守卫 no-op)。 | ②③ 退款是第二事件需独立幂等键;单列足够因「一次反转/请求」是本切片明确范围 |
| D3 | **payment_intent → request 映射唯一**:新增 `provider_payment_ref`(= payment_intent)**partial uniqueIndex(WHERE not null)**;confirm 时落库。退款先按它快查。 | **修正②**:原设计用普通 index + `.limit(1)`,映射非唯一、查询不确定;改为 DB 层唯一约束,1:1 钉死 |
| D4 | **查不到行时,经 Stripe 反查 session 判定归属,绝不无差别 200**:`sessions.list({ payment_intent })` →(a) 查到 session(是我们的)→ 用 `session.id` 匹配 `provider_ref`、并**回填** `provider_payment_ref`;(b) 查不到任何 session(非我们的)→ `ignored` 返回 200;(c) session 是我们的但 DB 无对应 request / 未就绪 → **抛错让 Stripe 重试**(覆盖 confirm/refund 竞态),不静默吞。 | **修正①④**:无差别 200 会静默丢失「本该撤销」的事件;经 session 反查同时解决历史无回填行(切片 #1 已存 `provider_ref=session.id`)与外部事件判定,**无需数据迁移** |
| D5 | **退款与 dispute 拆成两个归一化事件类型**(`RefundedPaymentEvent` / `DisputedPaymentEvent`)+ **两个审计动作**(`payment_auto_refunded` / `payment_auto_disputed`),共用同一个反转核心。 | **修正③**:二者语义不同(退款=主动、终态;拒付=对抗、有 won/lost 生命周期),不可用一个 `reason` 标志混过去 |
| D6 | **只对「全额退款」与「拒付创建(dispute.created)」反转**;部分退款(`amount_refunded < amount`)→ `ignored`(本切片不做按比例)。 | v0.2 不做对账/部分退款 |
| D7 | **dispute 在 `charge.dispute.created` 即撤销会员**(资金已被冻结/扣回,应立即停止付费内容访问)。dispute 后续判赢(won)**不自动复权**,需人工处理。 | 已确认(2026-06-19):created 即撤销对小创作者更安全;won 自动复权在范围外 |
| D8 | **反转核心抽成共享 helper**,管理员手动反转与自动退款/拒付都调它;差异只在 actor、reason 来源、审计动作、幂等键。`reversePaymentApproval` 对外行为不变。 | DRY;`paymentGrantLinkMissing` / 「已 revoked 跳过」逻辑只维护一处 |

## 2. Schema 变更 `src/db/schema/index.ts` + 迁移

`payment_requests` 加两列:

```ts
providerPaymentRef: text("provider_payment_ref"), // Stripe payment_intent；confirm 时落库；退款/拒付回查；1:1
reversalEventId: text("reversal_event_id"),        // 退款或拒付事件幂等键（独立于 provider_event_id）
```

索引/约束(追加到现有 `(table) => [ ... ]`,**均为 partial unique**,manual / 未支付行的 NULL 不冲突):

```ts
uniqueIndex("payment_requests_provider_payment_ref_unique")
  .on(table.providerPaymentRef)
  .where(sql`${table.providerPaymentRef} is not null`),
uniqueIndex("payment_requests_reversal_event_id_unique")
  .on(table.reversalEventId)
  .where(sql`${table.reversalEventId} is not null`),
```

迁移:`pnpm exec drizzle-kit generate`(纯加列 + 加 partial unique 索引,增量低风险,**无数据回填**——历史行的回填走 §5.3 运行时 lazy 回填,不在迁移里)。

## 3. provider 抽象 `src/modules/payment/providers/index.ts`(扩展)

退款与拒付**分开**两个事件类型(修正③);并入联合:

```ts
export type RefundedPaymentEvent = {
  type: "refunded";
  paymentRef: string;        // Stripe payment_intent
  providerEventId: string;   // 写入 reversal_event_id 做幂等
};

export type DisputedPaymentEvent = {
  type: "disputed";
  paymentRef: string;        // Stripe payment_intent
  providerEventId: string;
};

export type NormalizedPaymentEvent =
  | PaidPaymentEvent
  | ExpiredPaymentEvent
  | RefundedPaymentEvent
  | DisputedPaymentEvent
  | { type: "ignored"; providerEventId: string };
```

`PaidPaymentEvent` 增加 `paymentRef: string`(见 §4.1)。

`PaymentProvider` 契约新增归属解析方法:

```ts
// 经 payment_intent 反查我们创建的 Checkout Session：
//   null = 非本应用创建（外部事件）；否则返回 session 信息用于匹配 + 回填
resolveCheckoutByPaymentIntent(paymentRef: string): Promise<
  { providerRef: string; requestId?: string } | null
>;
```

## 4. Stripe 适配器 `src/modules/payment/providers/stripe.ts`(扩展)

### 4.1 paid 事件补存 payment_intent

`checkout.session.completed`(已有分支)的 `PaidPaymentEvent` 增加 `paymentRef: session.payment_intent`(`mode:"payment"` 下为字符串 id)。`payment_intent` 为空视为异常 → `ApiError(422, "stripeEventInvalid")`(同步卡支付恒有)。`confirmAutoPayment` 把它写入 `provider_payment_ref`(§5.1)。

### 4.2 退款分支(全额)

```ts
if (event.type === "charge.refunded") {
  const charge = event.data.object as Stripe.Charge;
  if (!charge.refunded || charge.amount_refunded !== charge.amount) {
    return { type: "ignored", providerEventId: event.id }; // 部分退款不处理
  }
  if (!charge.payment_intent) throw new ApiError(422, "stripeEventInvalid");
  return {
    type: "refunded",
    paymentRef: typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id,
    providerEventId: event.id,
  };
}
```

### 4.3 拒付分支(创建)

```ts
if (event.type === "charge.dispute.created") {
  const dispute = event.data.object as Stripe.Dispute;
  if (!dispute.payment_intent) throw new ApiError(422, "stripeEventInvalid");
  return {
    type: "disputed",
    paymentRef: typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent.id,
    providerEventId: event.id,
  };
}
```

其余事件继续走现有 `ignored` 兜底。

### 4.4 归属解析

```ts
async resolveCheckoutByPaymentIntent(paymentRef: string) {
  const list = await this.client.checkout.sessions.list({ payment_intent: paymentRef, limit: 1 });
  const session = list.data[0];
  if (!session) return null; // 非本应用创建
  return { providerRef: session.id, requestId: session.metadata?.requestId || undefined };
}
```

> `sessions.list` 需要 `checkout` 资源权限(已有)。`StripeClient` 类型 `Pick` 已含 `checkout`,无需扩。

## 5. Service `src/modules/payment/index.ts`(扩展)

### 5.1 confirm 时落库 payment_intent

`confirmAutoPayment` 的条件更新 `pending_payment→approved` 里顺带写 `providerPaymentRef: event.paymentRef`。其它不变。

### 5.2 抽取共享反转核心(重构 `reversePaymentApproval`)

把「grant-link 守卫 + 撤销会员」抽成内部 helper,两个调用方共用(调用方各自先做 `approved→reversed` 条件更新并拿到 `reversed` 行):

```ts
async function applyMembershipReversal(
  tx: DbClient,
  reversed: PaymentRequest,
  ctx: {
    actor: { type: "admin"; id: string } | { type: "system"; id: null };
    reason: string;
    auditAction: "reverse" | "payment_auto_refunded" | "payment_auto_disputed";
    correlationId: string;
    auditAfterExtra?: Record<string, unknown>;
  },
): Promise<void> {
  const reverseEvent = await recordAudit(tx, {
    entityType: "payment_request", entityId: reversed.id,
    action: ctx.auditAction, actor: ctx.actor, reason: ctx.reason,
    before: { status: "approved" },
    after: { status: "reversed", ...(ctx.auditAfterExtra ?? {}) },
    correlationId: ctx.correlationId,
  });
  if (!reversed.grantedMembershipId) throw new ApiError(409, "paymentGrantLinkMissing");
  const [membership] = await tx.select().from(memberships)
    .where(eq(memberships.id, reversed.grantedMembershipId)).limit(1);
  if (!membership) throw new ApiError(404, "membershipNotFound");
  if (membership.status !== "revoked") {
    await revokeMembership(membership.id, {
      reason: ctx.reason, actor: ctx.actor, expectedVersion: membership.version,
      correlationId: ctx.correlationId, causationId: reverseEvent.id,
    }, tx);
  }
}
```

`reversePaymentApproval` 改为做完 `approved→reversed` 条件更新后调 `applyMembershipReversal(..., { actor:{type:"admin",id:reviewerId}, reason:trimmedReason, auditAction:"reverse", correlationId })`。**对外行为不变,旧回归测试逐条须全绿**(先重构跑绿,再加新逻辑)。

### 5.3 新增自动反转(webhook 调用,退款与拒付共用)

```ts
export async function reverseAutoPayment(
  providerId: string,
  event: RefundedPaymentEvent | DisputedPaymentEvent,
): Promise<void> {
  const provider = await getPaymentProvider(providerId);
  const auditAction = event.type === "disputed" ? "payment_auto_disputed" : "payment_auto_refunded";
  const reasonText = event.type === "disputed" ? "stripe dispute" : "stripe refund";

  await getDb().transaction(async (tx) => {
    // 1) 幂等：reversal_event_id 去重（注意不是 provider_event_id）
    const [processed] = await tx.select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(eq(paymentRequests.reversalEventId, event.providerEventId)).limit(1);
    if (processed) return;

    // 2) 快查：provider_payment_ref（新行）
    let [request] = await tx.select().from(paymentRequests)
      .where(and(
        eq(paymentRequests.provider, providerId),
        eq(paymentRequests.providerPaymentRef, event.paymentRef),
      )).limit(1).for("update");

    // 3) 查不到 → 经 Stripe 反查 session 判定归属（修正①④）
    if (!request) {
      const resolved = await provider!.resolveCheckoutByPaymentIntent(event.paymentRef);
      if (!resolved) return; // (b) 非本应用创建的外部事件 → 200 ignore
      const lookup = resolved.requestId
        ? or(eq(paymentRequests.providerRef, resolved.providerRef), eq(paymentRequests.id, resolved.requestId))
        : eq(paymentRequests.providerRef, resolved.providerRef);
      [request] = await tx.select().from(paymentRequests)
        .where(and(eq(paymentRequests.provider, providerId), lookup)).limit(1).for("update");
      // (c) session 是我们的但 DB 无对应 request（confirm 尚未落库的竞态 / 异常）→ 抛错让 Stripe 重试，不静默
      if (!request) throw new ApiError(409, "paymentRequestNotFound");
      // 命中历史行：lazy 回填 provider_payment_ref（partial unique 保证不冲突）
      if (!request.providerPaymentRef) {
        await tx.update(paymentRequests)
          .set({ providerPaymentRef: event.paymentRef })
          .where(eq(paymentRequests.id, request.id));
      }
    }

    // 4) 状态守卫
    if (request.status === "reversed") return;          // 已被反转（管理员或另一事件）→ 幂等 no-op
    if (request.status !== "approved") return;          // 非 approved（无会员可撤）→ no-op（ours，已记录在审计前提下）

    // 5) 条件更新 approved→reversed + 写 reversal_event_id
    const reversedAt = new Date();
    const [reversed] = await tx.update(paymentRequests)
      .set({ status: "reversed", reversalEventId: event.providerEventId, reviewNote: reasonText, reviewedAt: reversedAt, updatedAt: reversedAt })
      .where(and(eq(paymentRequests.id, request.id), eq(paymentRequests.status, "approved")))
      .returning();
    if (!reversed) return; // 竞态：被并发抢先

    // 6) 复用反转核心：审计（refunded / disputed 区分）+ 撤销会员
    await applyMembershipReversal(tx, reversed, {
      actor: { type: "system", id: null },
      reason: reasonText,
      auditAction,
      correlationId: randomUUID(),
      auditAfterExtra: { provider: providerId, reversalEventId: event.providerEventId, kind: event.type },
    });

    // 7)（可选）通知用户会员已撤销，见 §7
  });
}
```

要点(直接回应四条修正):
- **① 不无差别 200**:三态分明——外部事件(反查无 session)→ ignore 200;我们的但行查不到/未就绪 → throw → Stripe 重试(覆盖 refund 早于 confirm 落库的竞态);已 reversed → 幂等 200。
- **② 唯一映射**:`provider_payment_ref` partial unique,快查确定单行。
- **③ 退款≠拒付**:同一函数但 `auditAction`/`reasonText`/`kind` 区分;审计可分别检索。
- **④ 回填**:历史 approved 行(切片 #1 留下、无 `provider_payment_ref`)经 `provider_ref=session.id` 命中后 **lazy 回填**,无需数据迁移。
- 「我们的但行查不到」抛错由 Stripe 重试兜底(约 3 天);真·永久异常 Stripe 最终放弃,建议接监控告警(对账留作后续)。

## 6. Webhook 路由 `src/app/api/payments/webhook/stripe/route.ts`(扩展)

```ts
if (event.type === "paid") await confirmAutoPayment("stripe", event);
if (event.type === "expired") await expireAutoPayment("stripe", event);
if (event.type === "refunded" || event.type === "disputed") await reverseAutoPayment("stripe", event);
```

其余(验签 401、`stripeConfigIncomplete` 503、已验签事件 2xx、处理抛错 5xx 让 Stripe 重试)不变。

> Stripe Dashboard webhook 需勾选:`checkout.session.completed`、`checkout.session.expired`、**`charge.refunded`**、**`charge.dispute.created`**。在 PR 描述与 `docs/admin/payment-review.md` / Stripe 配置文档注明。

## 7. 邮件通知(推荐做,可标注后续)

退款/拒付撤销会员后通知用户。新增 outbox 模板 `membership_revoked`:
- `src/modules/tasks/handlers.ts`:`emailPayloadSchema` 加 `template: z.literal("membership_revoked")`(params:`tierName`);`runEmailTask` dispatch。
- `src/modules/mail`:`sendMembershipRevokedEmail(to, tierName, locale)`,文案中性(「您的会员已停用」),**不暴露内部 reason**。
- `reverseAutoPayment` 事务内 `enqueueTask(tx, { kind:"email", dedupeKey:\`email:membership_revoked:${reversed.id}\`, ... })`(取 user+tier,参照 `finalizeApprovedPayment` / `rejectPaymentRequest`)。
- i18n 三语补文案。

不做则 PR 注明留后续(撤销已审计、会员状态已更新,但**推荐做**以对齐 reject/activate 的用户感知)。

## 8. i18n

`{zh,en,ja}.ts` 补(若做邮件)`membership_revoked` 文案;新增错误码基本复用已有 `paymentGrantLinkMissing` / `membershipNotFound` / `paymentRequestNotFound`。

## 9. 测试

provider 单测(mock `stripe` SDK):
- `charge.refunded` **全额** → `refunded`(`paymentRef`=payment_intent);**部分**(`amount_refunded<amount`)→ `ignored`。
- `charge.dispute.created` → `disputed`。
- `payment_intent` 缺失 → `422`。
- `checkout.session.completed` 现带 `paymentRef`(回归)。
- `resolveCheckoutByPaymentIntent`:有 session → `{providerRef, requestId}`;无 → `null`。

真实 PG 集成(参照 `auto-payment.integration.test.ts`):
- 先 `confirmAutoPayment` 造一个 approved + 会员 + `provider_payment_ref` 的请求,再:
  - `reverseAutoPayment` 退款一次成功:`approved→reversed`、写 `reversal_event_id`、会员被 revoke、审计 `payment_auto_refunded`(causation 完整)。
  - dispute 路径成功:审计 `payment_auto_disputed`(**与退款审计动作不同**)。
  - **幂等**:同 `reversal_event_id` 二次 → no-op,会员不重复 revoke、不报错。
  - **唯一映射**:两个 request 不可写入同一 `provider_payment_ref`(partial unique 拒绝)。
  - **① 外部事件**:`resolveCheckoutByPaymentIntent` 返回 null(mock)→ no-op、**不报错、不动任何行**。
  - **① 我们的但行查不到 / 未就绪**(mock 反查到 session 但 DB 无 request,或 confirm 尚未落库)→ **抛错**(让 Stripe 重试),不静默。
  - **④ 历史回填**:构造一条 approved 但 `provider_payment_ref=NULL`(仅有 `provider_ref=session.id`)→ 反查命中并 **lazy 回填** + 成功反转。
  - **管理员已手动 reverse 后** webhook 到达 → no-op(status 已 reversed),会员仍 revoked。
  - `paymentGrantLinkMissing`:approved 但 `granted_membership_id` 为空 → throw 409、回滚、不误撤其它会员。
- 回归:**`reversePaymentApproval` 重构后所有旧用例逐条仍通过**。
- webhook 路由:`charge.refunded` / `charge.dispute.created` 已验签 → 触发反转并 200;伪造签名 → 401。

## 10. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 11. PR

- base `main`,draft,标题 `feat(payments): refund/dispute auto-reversal`。
- 描述:新增 `provider_payment_ref`(partial unique)/ `reversal_event_id`(partial unique)两列 + 迁移;`RefundedPaymentEvent` / `DisputedPaymentEvent`(分离);Stripe 全额退款 / dispute.created 解析 + `resolveCheckoutByPaymentIntent`;`reverseAutoPayment`(幂等 + 唯一快查 + session 反查归属判定 + lazy 回填 + 三态不静默);webhook dispatch;(可选)`membership_revoked` 邮件;Stripe Dashboard 需勾选两个新事件。
- 关联对应 issue。

## 12. 验收 checklist

- [ ] confirm 落 `provider_payment_ref`(payment_intent),partial **unique**,退款按它快查
- [ ] 反转幂等用独立 `reversal_event_id`(不污染 paid 的 `provider_event_id`),重放只撤销一次
- [ ] **未匹配事件不无差别 200**:外部(反查无 session)→ ignore;我们的但查不到/未就绪 → 抛错重试;已 reversed → 幂等 no-op
- [ ] **退款与 dispute 语义分离**:独立事件类型 + 独立审计动作 `payment_auto_refunded` / `payment_auto_disputed`
- [ ] **历史无回填行可处理**:经 `provider_ref=session.id` 反查命中并 lazy 回填,无需数据迁移
- [ ] 全额退款 / dispute.created → 撤销 `granted_membership_id` 对应会员;部分退款 → ignored
- [ ] 反转核心由管理员手动与自动**共用**;`reversePaymentApproval` 行为不变、旧测试全绿
- [ ] 自动反转 actor=system、causation 链完整;不误伤其它会员
- [ ]（推荐)用户收到会员撤销通知邮件
- [ ] 无敏感数据落库/入日志

## 不在本切片(后续)

- dispute 判赢(won)后**自动复权**会员;dispute 生命周期与对账。
- 部分退款的按比例 / 缩短会员时长。
- 「我们的但永久查不到」事件的自动对账/告警面板(现仅靠 Stripe 重试 + 日志)。
- 订阅/自动续费的失败扣款联动;多 provider(alipay/wechat)退款。
