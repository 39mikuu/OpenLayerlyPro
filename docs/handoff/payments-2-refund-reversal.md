# 交接：自动收付款 #2 — 退款 / 拒付联动撤销会员

> 给执行 agent 的自包含实现说明。**前置依赖:切片 #1(Stripe 一次性付款)已在 main**(`createAutoCheckout` / `confirmAutoPayment` / `expireAutoPayment` / webhook 路由 / `reversePaymentApproval` 均已合并)。落地决策见 [ADR 0005](../adr/0005-auto-payments.md) §6(Accepted)。
>
> 开工前在 GitHub 建一个 issue(如「feat(payments): refund/dispute auto-reversal」),PR 关联它。

这是自动支付的**第二个垂直切片**:Stripe `refunded` / `dispute` 回调 → **复用 #6 的会员撤销逻辑** → 自动把对应会员 revoke + 审计因果。**零新增状态机**(沿用 `payment_requests.status='reversed'`)。

## 0. 必读 / 现状

- 切片 #1 已落地的代码(本切片直接扩展,**别重写**):
  - `src/modules/payment/index.ts`
    - `confirmAutoPayment(providerId, event)` —— 已验签事件的**幂等确认**范式(`providerEventId` 去重 + `FOR UPDATE` + 条件更新 `pending_payment→approved` + grant + 审计 + outbox)。本切片的 `reverseAutoPayment` **照抄这套幂等骨架**。
    - `reversePaymentApproval(requestId, reviewerId, reason)` —— **管理员手动**反转:条件更新 `approved→reversed` + 审计 `reverse` + `revokeMembership(tx)`,含 `paymentGrantLinkMissing` 守卫与「会员已 revoked 则跳过」判断。本切片把它的**核心反转逻辑抽成共享 helper**,管理员路径与自动退款路径都调它。
    - `finalizeApprovedPayment(tx, row, context)` —— grant + 回写 `granted_membership_id` + 邮件入队的共享 helper(供参考其抽取范式)。
  - `src/modules/payment/providers/index.ts` —— `PaymentProvider` 契约 + `NormalizedPaymentEvent` 联合类型(`PaidPaymentEvent` / `ExpiredPaymentEvent` / `ignored`)。本切片**新增 `RefundedPaymentEvent`**。
  - `src/modules/payment/providers/stripe.ts` —— `parseWebhook` 已处理 `checkout.session.completed` / `checkout.session.expired`。本切片**新增 `charge.refunded` / `charge.dispute.created` 分支**。
  - `src/app/api/payments/webhook/stripe/route.ts` —— 已 dispatch `paid` / `expired`。本切片**新增 `refunded` dispatch**。
  - `src/modules/membership/index.ts`:`revokeMembership(id, { reason, actor, expectedVersion, correlationId, causationId }, tx)`。
  - `src/modules/audit`:`recordAudit(tx, ...)`;`src/modules/tasks`:`enqueueTask(tx, ...)`。
  - `src/modules/tasks/handlers.ts` + `src/modules/mail`:邮件模板的 discriminated union + 发送函数(本切片**可选**新增 `membership_revoked` 模板,见 §7)。
- 现状关键事实:
  - `payment_requests.provider_event_id` 是**单列 + 唯一索引**,切片 #1 里被 `confirmAutoPayment`(paid 事件)或 `expireAutoPayment`(expired 事件)写入。**一个请求一生只写一次**(paid 与 expired 互斥,都从 `pending_payment` 转出)。
  - ⚠️ **退款是 `approved` 之后的第二个权威事件**,它**不能**复用同一个 `provider_event_id` 列做幂等——该列已被 paid 事件占用。本切片必须为退款事件引入**独立的幂等存储**(见 D2)。
  - ⚠️ **Stripe 退款/拒付事件不带 Checkout Session id**。`charge.refunded` / `charge.dispute.created` 的对象是 charge / dispute,只有 `payment_intent`,**没有 `session.id`(= 我们存的 `providerRef`)**。因此必须建立 `payment_intent → payment_request` 的映射(见 D3)。

## 1. 已锁定决策(动工前若有异议先提)

| # | 决策 | 理由 |
|---|---|---|
| D1 | **退款/拒付 → 复用反转核心,撤销 `granted_membership_id` 对应会员**。沿用 `status='reversed'`,**不新增状态**。 | ADR 0005 §6;零新增状态机 |
| D2 | **新增退款事件幂等列 `refund_event_id text` + `uniqueIndex`**(独立于 `provider_event_id`,因后者已被 paid 占用)。退款 webhook 先按它去重,重放只反转一次。 | 一个请求的 paid / refund 是两个不同事件,需各自幂等键;PG 允许多 NULL,manual 行不受影响 |
| D3 | **paid 确认时额外存 `provider_payment_ref`(Stripe `payment_intent`)+ index**;退款事件按 `payment_intent` 回查 request。 | charge/dispute 不带 session id;在 confirm 时一次性落库,避免退款时再调 Stripe API list |
| D4 | **只对「全额退款」与「拒付(dispute.created)」反转**;部分退款 → `ignored`(本切片不做按比例处理)。 | v0.2 不做对账/部分退款;ADR 明确退款=全额联动撤销。全额判定:`charge.amount_refunded === charge.amount` |
| D5 | **反转核心抽成共享 helper**,管理员手动反转与自动退款反转都调它;差异只在 actor(admin vs system)、reason 来源、幂等键。 | DRY;`paymentGrantLinkMissing` / 「已 revoked 跳过」逻辑只维护一处 |
| D6 | 自动退款审计 action = **`payment_auto_refunded`**(管理员仍是 `reverse`);actor = `{ type:"system", id:null }`;`causationId` 指向退款审计事件。 | 与 `payment_auto_paid` 对称,审计可区分人工/自动 |
| D7 | **拒付(dispute)只做单向撤销**;dispute 后续被判赢(`charge.dispute.closed` won)**不自动重新开通**会员,留作后续/人工。 | dispute 生命周期(won/lost/reversed)是另一坨;v0.2 不做对账与自动复权 |

## 2. Schema 变更 `src/db/schema/index.ts` + 迁移

`payment_requests` 加两列:

```ts
providerPaymentRef: text("provider_payment_ref"), // Stripe payment_intent，confirm 时落库，退款回查用
refundEventId: text("refund_event_id"),           // 退款/拒付事件幂等键（独立于 provider_event_id）
```

索引/约束(追加到现有 `(table) => [ ... ]`):

```ts
index("payment_requests_provider_payment_ref_idx").on(table.providerPaymentRef),
uniqueIndex("payment_requests_refund_event_id_unique").on(table.refundEventId),
```

迁移:`pnpm exec drizzle-kit generate`(纯加列 + 加索引,增量低风险,无回填)。

## 3. provider 抽象 `src/modules/payment/providers/index.ts`(扩展)

新增退款事件类型并并入联合:

```ts
export type RefundedPaymentEvent = {
  type: "refunded";
  paymentRef: string;        // Stripe payment_intent（= confirm 时存的 provider_payment_ref）
  providerEventId: string;   // 写入 refund_event_id 做幂等
  reason: "refund" | "dispute";
};

export type NormalizedPaymentEvent =
  | PaidPaymentEvent
  | ExpiredPaymentEvent
  | RefundedPaymentEvent
  | { type: "ignored"; providerEventId: string };
```

`PaymentProvider.parseWebhook` 签名不变(返回类型已含新成员)。

## 4. Stripe 适配器 `src/modules/payment/providers/stripe.ts`(扩展)

### 4.1 paid 事件补存 payment_intent

`checkout.session.completed`(已有分支)的 `PaidPaymentEvent` 增加 `paymentRef: session.payment_intent`(`mode:"payment"` 下是字符串 id)。

- 同步更新 `PaidPaymentEvent` 类型加 `paymentRef: string`(在 `providers/index.ts`)。
- `session.payment_intent` 可能为 `null`/对象:仅当为非空字符串时取用;为空则 `paymentRef=""` 或抛 `422`(同步卡支付下恒有 payment_intent,缺失视为异常 → `ApiError(422, "stripeEventInvalid")`)。
- `confirmAutoPayment` 把它写入 `provider_payment_ref`(见 §5.1)。

### 4.2 退款 / 拒付分支

在 `parseWebhook` 里新增(放在现有 `expired` / `completed` 判断旁):

```ts
if (event.type === "charge.refunded") {
  const charge = event.data.object as Stripe.Charge;
  // 仅全额退款才联动撤销；部分退款 → ignored（本切片不处理）
  if (!charge.refunded || charge.amount_refunded !== charge.amount) {
    return { type: "ignored", providerEventId: event.id };
  }
  if (!charge.payment_intent) throw new ApiError(422, "stripeEventInvalid");
  return {
    type: "refunded",
    paymentRef: typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent.id,
    providerEventId: event.id,
    reason: "refund",
  };
}

if (event.type === "charge.dispute.created") {
  const dispute = event.data.object as Stripe.Dispute;
  if (!dispute.payment_intent) throw new ApiError(422, "stripeEventInvalid");
  return {
    type: "refunded",
    paymentRef: typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent.id,
    providerEventId: event.id,
    reason: "dispute",
  };
}
```

其余事件继续走现有 `ignored` 兜底。

## 5. Service `src/modules/payment/index.ts`(扩展)

### 5.1 confirm 时落库 payment_intent

在 `confirmAutoPayment` 的条件更新 `pending_payment→approved` 里,顺带写入 `providerPaymentRef: event.paymentRef`(`PaidPaymentEvent` 现在带它)。其它逻辑不变。

> 注意:`provider_payment_ref` 是退款回查的唯一锚点。若某历史 approved 行没有它(理论上 v0.2 不会,因 confirm 一定带),退款将查不到 → 见 §5.3 的「查不到 request」处理。

### 5.2 抽取共享反转核心(重构 `reversePaymentApproval`)

把「`approved→reversed` 条件更新 + grant-link 守卫 + 撤销会员」抽成内部 helper,**两个调用方共用**:

```ts
type ReversalContext = {
  actor: { type: "admin"; id: string } | { type: "system"; id: null };
  reason: string;
  auditAction: "reverse" | "payment_auto_refunded";
  correlationId: string;
  // 自动路径额外写入的字段（幂等键 + 来源）
  refundEventId?: string;
  auditAfterExtra?: Record<string, unknown>;
};

// 调用前：调用方已用条件 UPDATE 把行置为 reversed 并拿到 row（保证并发守卫一致）
async function applyMembershipReversal(
  tx: DbClient,
  reversed: PaymentRequest,
  ctx: ReversalContext,
): Promise<void> {
  const reverseEvent = await recordAudit(tx, {
    entityType: "payment_request",
    entityId: reversed.id,
    action: ctx.auditAction,
    actor: ctx.actor,
    reason: ctx.reason,
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
      reason: ctx.reason,
      actor: ctx.actor,
      expectedVersion: membership.version,
      correlationId: ctx.correlationId,
      causationId: reverseEvent.id,
    }, tx);
  }
}
```

`reversePaymentApproval` 改为:做完 `approved→reversed` 条件更新后,调 `applyMembershipReversal(tx, updated, { actor:{type:"admin",id:reviewerId}, reason:trimmedReason, auditAction:"reverse", correlationId })`。**对外行为不变,回归测试应继续全绿**。

> ⚠️ 重构是「不改外部行为的内部抽取」。先跑现有 `payment/index.integration.test.ts` 确认 `reversePaymentApproval` 的所有用例(含 `paymentGrantLinkMissing`、`paymentNotApproved`、会员已 revoked 跳过)在重构后**逐条仍通过**,再加自动退款逻辑。

### 5.3 新增自动退款反转(webhook 调用)

照抄 `confirmAutoPayment` / `expireAutoPayment` 的幂等骨架:

```ts
export async function reverseAutoPayment(
  providerId: string,
  event: RefundedPaymentEvent,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    // 1) 幂等：refund_event_id 去重（注意是新列，不是 provider_event_id）
    const [processed] = await tx.select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(eq(paymentRequests.refundEventId, event.providerEventId)).limit(1);
    if (processed) return;

    // 2) 按 payment_intent 回查 + FOR UPDATE
    const [request] = await tx.select().from(paymentRequests)
      .where(and(
        eq(paymentRequests.provider, providerId),
        eq(paymentRequests.providerPaymentRef, event.paymentRef),
      ))
      .limit(1).for("update");
    // 查不到 / 已不是 approved（如已被管理员手动 reverse）→ no-op，返回 200
    if (!request || request.status !== "approved") return;

    // 3) 条件更新 approved→reversed + 写 refund_event_id（并发/重放守卫）
    const reversedAt = new Date();
    const reasonText = event.reason === "dispute" ? "stripe dispute" : "stripe refund";
    const [reversed] = await tx.update(paymentRequests)
      .set({
        status: "reversed",
        refundEventId: event.providerEventId,
        reviewNote: reasonText,
        reviewedAt: reversedAt,
        updatedAt: reversedAt,
      })
      .where(and(
        eq(paymentRequests.id, request.id),
        eq(paymentRequests.status, "approved"),
      ))
      .returning();
    if (!reversed) return;

    // 4) 复用共享反转核心：审计 payment_auto_refunded + 撤销会员
    await applyMembershipReversal(tx, reversed, {
      actor: { type: "system", id: null },
      reason: reasonText,
      auditAction: "payment_auto_refunded",
      correlationId: randomUUID(),
      auditAfterExtra: { provider: providerId, refundEventId: event.providerEventId, refundReason: event.reason },
    });

    // 5)（可选）通知用户会员已因退款撤销，见 §7
  });
}
```

要点:
- **幂等键是 `refund_event_id`,不是 `provider_event_id`**(后者仍持有 paid 事件 id)。
- 查不到 request(payment_intent 对不上,或历史无 `provider_payment_ref`)→ no-op 返回 200,**不要 throw**(避免 Stripe 无限重试一个永远匹配不上的事件)。可 `recordEvent`/日志留痕便于排查。
- 已被管理员手动 `reverse`(status 已是 `reversed`)→ 条件更新 0 行 → no-op,会员早已撤销,幂等安全。
- `applyMembershipReversal` 内的「会员已 revoked 则跳过 revoke」保证与管理员反转、或重复事件之间不冲突。

## 6. Webhook 路由 `src/app/api/payments/webhook/stripe/route.ts`(扩展)

dispatch 加一行:

```ts
if (event.type === "paid") await confirmAutoPayment("stripe", event);
if (event.type === "expired") await expireAutoPayment("stripe", event);
if (event.type === "refunded") await reverseAutoPayment("stripe", event);
```

其余(验签失败 401、`stripeConfigIncomplete` 503、已验签事件返回 2xx、处理抛错 5xx 让 Stripe 重试)保持不变。

> Stripe Dashboard 的 webhook 需勾选事件:`checkout.session.completed`、`checkout.session.expired`、**`charge.refunded`**、**`charge.dispute.created`**。在 PR 描述与 `docs/admin/payment-review.md` / Stripe 配置文档里补这两项。

## 7. 邮件通知(推荐做,可标注后续)

退款撤销会员后,用户侧应有感知。建议新增 outbox 邮件模板 `membership_revoked`:

- `src/modules/tasks/handlers.ts`:`emailPayloadSchema` 加一个 `template: z.literal("membership_revoked")` 分支(params:`tierName`,可选 `reason`);`runEmailTask` 加 dispatch。
- `src/modules/mail`:加 `sendMembershipRevokedEmail(to, tierName, locale)`(文案中性,如「您的会员已停用」,**不暴露内部 reason 文本**)。
- 在 `reverseAutoPayment` 的事务内 `enqueueTask(tx, { kind:"email", dedupeKey:\`email:membership_revoked:${reversed.id}\`, payload:{ template:"membership_revoked", to, locale, params:{ tierName } } })`(取 user + tier,参照 `finalizeApprovedPayment` / `rejectPaymentRequest` 取收件人范式)。
- i18n:`{zh,en,ja}.ts` 补该邮件文案。

若本切片不做邮件,在 PR 注明留作后续(撤销本身已审计、会员状态已更新,无声撤销也可接受,但**推荐做**以对齐 reject/activate 的用户感知)。

## 8. i18n

`{zh,en,ja}.ts` 补(若做邮件):`membership_revoked` 邮件主题/正文。新增 API 错误码若有也补(本切片基本复用已有 `paymentGrantLinkMissing` / `membershipNotFound`)。

## 9. 测试

provider 单测(mock `stripe` SDK,扩 `stripe.ts` 测试):
- `charge.refunded` **全额** → `refunded` 事件(`paymentRef`=payment_intent、`reason:"refund"`)。
- `charge.refunded` **部分**(`amount_refunded < amount`)→ `ignored`。
- `charge.dispute.created` → `refunded`(`reason:"dispute"`)。
- `payment_intent` 缺失 → `422`。
- `checkout.session.completed` 现在带 `paymentRef`(回归:paid 事件含 payment_intent)。

真实 PG 集成(参照 `auto-payment.integration.test.ts`):
- 先 `confirmAutoPayment` 建一个 approved + 会员 + `provider_payment_ref` 的请求,再:
  - `reverseAutoPayment` 一次成功:`approved→reversed`、写 `refund_event_id`、会员被 revoke、审计 `payment_auto_refunded`(causation 指向反转事件)。
  - **幂等**:同 `refund_event_id` 二次 → no-op,会员不被重复 revoke、不报错。
  - **payment_intent 对不上** → no-op、不报错、不影响任何行。
  - **管理员已手动 reverse 后** webhook 退款到达 → no-op(status 已 reversed),会员仍是 revoked。
  - **dispute 路径** 同样能撤销。
  - `paymentGrantLinkMissing`:approved 但 `granted_membership_id` 为空(构造)→ throw 409、事务回滚、不误撤其它会员。
- 回归:**`reversePaymentApproval` 重构后所有旧用例逐条仍通过**(管理员手动反转、`paymentNotApproved`、会员已 revoked 跳过、`paymentGrantLinkMissing`)。
- webhook 路由:`charge.refunded` 已验签 → 触发反转并 200;伪造签名 → 401。

## 10. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 11. PR

- base `main`,draft,标题 `feat(payments): refund/dispute auto-reversal`。
- 描述:新增 `provider_payment_ref` / `refund_event_id` 两列 + 迁移;`RefundedPaymentEvent`;Stripe `charge.refunded`(全额)/ `charge.dispute.created` 解析;`reverseAutoPayment`(幂等 + payment_intent 回查 + 复用反转核心);webhook dispatch;(可选)`membership_revoked` 邮件;需在 Stripe Dashboard 勾选两个新事件。
- 关联对应 issue。

## 12. 验收 checklist

- [ ] confirm 时落 `provider_payment_ref`(payment_intent);退款按它回查 request
- [ ] 退款幂等用独立 `refund_event_id`(不污染 paid 的 `provider_event_id`),重放只撤销一次
- [ ] 全额退款 / dispute.created → 撤销 `granted_membership_id` 对应会员;部分退款 → ignored
- [ ] 反转核心由管理员手动与自动退款**共用**;`reversePaymentApproval` 行为不变、旧测试全绿
- [ ] 自动退款审计 `payment_auto_refunded`、actor=system、causation 链完整
- [ ] payment_intent 对不上 / 已 reversed → no-op 返回 200,不让 Stripe 无限重试、不误伤其它会员
- [ ]（推荐)用户收到会员撤销通知邮件
- [ ] 无敏感数据落库/入日志

## 不在本切片(后续)

- dispute 被判赢(won)后**自动复权**会员;dispute 生命周期对账。
- 部分退款的按比例/缩短会员时长。
- 订阅/自动续费的失败扣款联动;对账报表;多 provider(alipay/wechat)退款。
