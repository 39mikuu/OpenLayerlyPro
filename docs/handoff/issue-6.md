# 交接：#6 付款审核审计链路 + 反转

> 给执行 agent 的自包含实现说明。**前置依赖：#4（PR #15）已合并**——本任务复用其 `audit_events` 表、`recordAudit(tx)`、`pickMembershipAudit`、以及生命周期 service（`revokeMembership` 等）。

## 0. 必读

- `docs/adr/0002-audit-and-event-strategy.md`（Accepted）— 审计表 + `correlation_id` / `causation_id` 因果模型
- `docs/architecture/membership-lifecycle.md` — 生命周期 service 形态
- GitHub issue #6
- 现有代码：`src/modules/payment/index.ts`（approve/reject/resubmit/cancel）、`src/modules/membership/index.ts`（grant/revoke）

**范围**：付款审核状态变更的审计化 + 与会员授权的因果链 + 反转（reversal）。
**不含**：付款 provider webhook、自动对账、后台批量审核 UI（这些是非目标 / 后续）。

## 1. 已锁定的设计决策（动工前若有异议先提）

| # | 决策 | 取舍理由 |
|---|---|---|
| D1 | **反转用新增 payment 状态 `reversed`**（status 枚举加一个值）。 | 可查询、可作并发幂等守卫（仅 `approved → reversed` 一次成功）。 |
| D2 | **在 `payment_requests` 增加 `granted_membership_id`（uuid，可空）**，approve 时写入。反转据此精确 revoke 那一条 membership。 | 业务流程不依赖 audit 行（审计应是观察性的，不可成为 load-bearing；审计可被裁剪）。因果链仍由 `causation_id` 记录用于观测。 |
| D3 | **#6 只做 reversal，不做「就地修改 tier/时长」的 correction**。需要更正时 = 反转 + 重新开通。 | 避免复杂的就地编辑流；保持每笔权益对应一条可追溯 grant。 |
| D4 | **付款审计事件用 `recordAudit` 写在事务内**，取代现有事务后、且失败被吞的 `recordEvent`（app_events）。`app_events` 仅留作非审计遥测。 | ADR 0002：状态与审计同提交/同回滚。 |
| D5 | **邮件仍在事务后发送**（失败仅记日志），到 #7 再改为 outbox。 | #7 范围，不在本任务。 |

## 2. Schema 变更 `src/db/schema/index.ts`

`paymentRequests`：

```ts
status: text("status", {
  enum: ["pending_review", "approved", "rejected", "cancelled", "reversed"], // 加 reversed
}).notNull(),
// 新增：
grantedMembershipId: uuid("granted_membership_id"),
```

迁移：`pnpm exec drizzle-kit generate`。枚举加值 + 加可空列，存量行不受影响、无需回填。

## 3. Service 改动 `src/modules/payment/index.ts`

通用约定：每个审核操作在**单事务内**完成「状态条件更新 + `recordAudit(tx)`」。`correlationId` 在操作入口 `randomUUID()` 生成并贯穿；被触发的会员事件用 `causationId` 指向付款事件 id。

### 3.1 approve（改造现有 `approvePaymentRequest`）

事务内：

1. 条件更新 `where id=? and status='pending_review'` → `approved`（保留现有幂等守卫）。命中 0 行 → `ApiError(400, "paymentNotPending")`。
2. `const approveEvent = await recordAudit(tx, { entityType:"payment_request", entityId:requestId, action:"approve", actor:{type:"admin",id:reviewerId}, before:{status:"pending_review"}, after:{status:"approved"}, correlationId })`
3. `const { membership } = await grantMembership({ ..., actor:{type:"admin",id:reviewerId}, correlationId, causationId: approveEvent.id }, tx)`
   - grant 的审计事件会因此 `causation_id = approveEvent.id`（因果链）。
4. 回写 `granted_membership_id = membership.id`（同一事务 update payment_requests）。

事务后：保留发邮件（D5）。**删除原事务后的 `recordEvent("payment_request_approved")`**（已由 audit 取代；如需保留遥测可同时 recordEvent，但审计以 audit_events 为准）。

### 3.2 reject / resubmit / cancel（补审计）

- 维持现有条件更新与状态守卫不变。
- 在各自事务内补 `recordAudit(tx, { entityType:"payment_request", action:"reject|resubmit|cancel", actor, before, after, correlationId })`。
  - `reject`：actor=admin（reviewerId）。
  - `resubmit` / `cancel`：actor=user（该 userId）。
- 把原事务后的 `recordEvent(...)` 移入事务内或替换为 audit（D4）。

> 注意：现有 `resubmit`/`cancel` 是单语句条件更新、未显式开事务。补审计时需包成 `db.transaction`，把条件更新与 `recordAudit` 放进去。

### 3.3 reverse（新增 `reversePaymentApproval`）

```ts
reversePaymentApproval(requestId: string, reviewerId: string, reason: string): Promise<PaymentRequest>
```

事务内：

1. `reason` 必填（trim 非空），否则 `ApiError(400, "reviewReasonRequired")`。
2. 条件更新 `where id=? and status='approved'` → `reversed`。命中 0 行 → `ApiError(409, "paymentNotApproved")`（幂等：重复反转只成功一次）。
3. `const reverseEvent = await recordAudit(tx, { entityType:"payment_request", action:"reverse", actor:{type:"admin",id:reviewerId}, reason, before:{status:"approved"}, after:{status:"reversed"}, correlationId })`
4. 取 `granted_membership_id`；若存在，调用生命周期 revoke——**复用 #4 的 `revokeMembership`**，传 `correlationId` 与 `causationId: reverseEvent.id`，使会员 revoke 事件挂到反转事件下。
   - revoke 需要 `expectedVersion`：先在事务内读该 membership 当前 version 再调用（注意 revoke 内部自起事务的问题，见下「实现注意」）。
   - 若该 membership 已是 revoked（例如已被手动撤销）→ 视为已达终态，跳过 revoke，仅记录反转事件（不要因 `alreadyInState` 让整笔反转失败）。

### 实现注意：嵌套事务

`revokeMembership` 当前**自起 `getDb().transaction`**，无法直接复用同一事务句柄。两条路（任选，推荐 A）：

- **A（推荐）**：把 `changeMembership` 的核心抽成接受 `tx` 的内部函数 `changeMembershipWithClient(tx, ...)`，`revokeMembership` 等保持「无 tx 时自起事务、有 tx 时复用」的双形态（与 `grantMembership` 已有的 `grantMembershipWithClient` 模式一致）。reverse 在自己的事务里调内部版。
- B：reverse 不复用生命周期 service，直接在本事务内对 membership 做条件更新 + `recordAudit`。**不推荐**（重复状态机逻辑，易与 #4 漂移）。

## 4. i18n

在 `src/modules/i18n/messages/{zh,en,ja}.ts` 补错误文案：`paymentNotApproved`、`reviewReasonRequired`（以及任何新增 key）。

## 5. 测试（issue #6 验收）

参照 #4 的集成测试风格（真实 PG，见 `src/modules/membership/index.integration.test.ts`）：

- 每种转移恰好产生一条 durable 审计事件。
- approve 不会因重复请求开通两次会员（并发 + 重复审核）。
- approve 事件与 membership grant 事件共享 `correlation_id`，且 grant 事件 `causation_id = approve 事件 id`。
- reverse：approved→reversed 一次成功；重复 reverse → `paymentNotApproved`；reverse 后对应 membership 变 revoked 且 revoke 事件 `causation_id = reverse 事件 id`；该用户随后 `getActiveMembership` 返回 null（若无其它有效 grant）。
- 部分失败回滚：审计插入失败（可复用触发器手法）时，付款状态、会员状态、审计全部回滚。
- resubmit/cancel/reject 均产生正确 actor 的审计事件。

## 6. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm test && pnpm build:migrator && pnpm build
```

## 7. PR

- base `main`，draft，标题 `feat(payment): add payment review audit trail and reversal`。
- 描述声明：schema/迁移（加 `reversed` 状态 + `granted_membership_id`）、审计改造（recordAudit 入事务）、新增 reverse、因果链、CI。
- 关联 `Closes #6`。

## 8. 验收 checklist

- [ ] 每种付款转移恰好一条 durable 审计事件
- [ ] 重复 approve 不重复开通会员
- [ ] 付款事件与会员事件共享 `correlation_id` 且 `causation_id` 正确串联
- [ ] 部分失败时付款态/会员态/审计一起回滚
- [ ] reverse 幂等（approved→reversed 一次）且联动 revoke 对应 membership
- [ ] 测试覆盖并发审核、stale、重复 approve、resubmit、cancel、reverse、rollback
