# 会员生命周期设计稿（#4）

> ✅ 已实现。本稿为 issue #4 的实现蓝图，落地决策见 [ADR 0001](../adr/0001-membership-lifecycle-model.md)（会员模型）与 [ADR 0002](../adr/0002-audit-and-event-strategy.md)（审计）。
>
> 范围限定 service + schema 层，**不含**后台 UI（#5）、邮件（#7）、付款事件 schema（#6）。

## 1. 目标

为会员引入完整、可审计的生命周期，作为 #5/#6 的地基：

- 显式且校验的状态转移；非法转移确定性拒绝。
- 会员状态变更与历史记录同提交或同回滚。
- 权限判定收敛到唯一的「有效会员」规则。
- 并发不静默覆盖（乐观锁强制校验）；幂等键去重推迟到后续 PR（见 §5）。

## 2. 现状与差距

| 现状 | 差距 |
|---|---|
| `memberships` 无 `status`，有效性靠时间窗派生 | 无封禁/撤销概念 |
| `grantMembership` 同级/更高级顺延叠加 | 无 revoke/suspend/resume/extend |
| `recordEvent` 写 `app_events`，且在事务**外** | 无 actor/before-after，状态与事件可能不一致 |
| `updateMembership` 无条件 `.set()` | 并发会静默覆盖 |

## 3. Schema 变更

### 3.1 `memberships` 加列

```ts
// status：存储态。expired/scheduled 为派生态，不落库（见 ADR 0001）
status: text("status", { enum: ["active", "suspended", "revoked"] })
  .notNull()
  .default("active"),
// version：乐观锁，所有生命周期写操作走条件更新
version: integer("version").notNull().default(0),
```

迁移：加两列 → 回填存量行 `status='active'`、`version=0` → 置非空默认。属于纯增量、低风险迁移。

### 3.2 审计历史

不新建 membership 专用历史表，复用 ADR 0002 的统一 `audit_events`（`entity_type='membership'`）。本设计稿假设该表由 #4 一并引入（#6 复用）。

## 4. 状态模型

**grant 有效性判定（唯一入口）**——注意**不含 `tier.isActive`**（见 ADR 0001，对现状的有意修正）：

```txt
有效 ⇔ status = 'active' ∧ startsAt <= now < endsAt
```

`tier.isActive` / `tier.purchaseEnabled` 只决定该等级**能否售卖/是否展示**，不影响已发放权益。停售/隐藏等级不取消已付费用户的会员。

派生态（仅用于展示，不落库）：

- `expired`：`endsAt <= now`
- `scheduled`：`startsAt > now`（预留，当前 grant 默认即时生效）

**允许的转移**（非法转移抛 `ApiError(409, "invalidMembershipTransition")`）。状态转移只改存储态、与时间窗正交；`extend` 只改窗、保持状态：

| 当前存储态 | suspend | resume | revoke | extend |
|---|:--:|:--:|:--:|:--:|
| active | → suspended | — | → revoked | endsAt 延长，**仍 active** |
| suspended | — | → active | → revoked | endsAt 延长，**仍 suspended** |
| revoked（终态） | — | — | — | — |

派生态前置条件（消除歧义，完整口径见 ADR 0001）：

- **过期记录（endsAt ≤ now）不可 extend**；要再开通走新的 `grantMembership`（renew = 新增 grant 行）。
- `extend` 仅在 `endsAt > now` 时允许，`endsAt = endsAt + days`（不从 now 重新计）。
- scheduled（startsAt > now）grant 可 suspend / resume / revoke / extend。
- `resume` 只恢复存储态，不改时间窗；对已过期记录 resume 后仍无访问权（无害）。
- `revoked` 终态不可逆（含 extend）。

## 5. Service API

所有写操作：单事务内「条件更新（含 version 守卫）+ `recordAudit(tx, ...)`」，共享 `correlation_id`；被上游触发时携带 `causationId`（指向上游审计事件 id，见 ADR 0002）。审计写入失败整笔回滚。

```ts
type LifecycleActor = { type: "admin" | "system"; id: string | null };

// 条件更新 where id=? and version=? and status in (...允许的来源态)
suspendMembership(id, { reason, actor, expectedVersion }): Promise<Membership>
resumeMembership(id,  { reason, actor, expectedVersion }): Promise<Membership>
revokeMembership(id,  { reason, actor, expectedVersion }): Promise<Membership>
extendMembership(id,  { days,   actor, expectedVersion }): Promise<Membership>
```

返回前 `version` 自增。命中 0 行区分三种错因（再查该行判断）：

- 行不存在 → `ApiError(404, "membershipNotFound")`。
- 行存在但 version 不符 → `ApiError(409, "membershipStale")`（#5 据此提示「已被他人修改，请刷新」）。
- 行存在、version 相符但已是该目标态 → `ApiError(409, "alreadyInState")`。
- 行存在但来源态不允许该转移（非上一条） → `ApiError(409, "invalidMembershipTransition")`。

并发与幂等（ADR 0001 决策 7，#4 采用精简方案）：

- **不设「目标态相同就静默 no-op」**。每个命令一律严格校验来源态 + `expectedVersion`，**绝不因目标态相同而跳过乐观锁**——否则会掩盖并发修改。
- 对已是该态的命令返回确定性 `alreadyInState`，而非假装成功。
- **有害的重复副作用由乐观锁兜底**：双击 extend 时第二次请求持旧 version，条件更新命中 0 行 → `membershipStale`，不会重复延期。
- **不在 #4 引入 `dedupeKey`/幂等键**。基于幂等键的「重试返回首次结果」推迟到后续 API 层 PR；届时按 ADR 0002 加 `audit_events.idempotency_key` + `UNIQUE(actor_type, actor_id, action, idempotency_key)`。

## 6. 权限判定改造

`getActiveMembership` / `getActiveLevel`：**去掉 `tier.isActive` 过滤**、**加 `status='active'` 过滤**。需全量排查所有「有效会员」读取点：

- 付款开通后的等级比较（`grantMembership` 内的 `getActiveMembership`）。
- 内容三级权限的 member 判定（content 模块）。
- `/me`、tiers、checkout 等前台页面。

> ⚠️ 这是最容易遗漏的一致性面，且**改变了现有行为**（停用 tier 不再砍权益）。任何绕过 `getActiveMembership` 直接查 `memberships` 或额外 join `tier.isActive` 的地方都要改。#12 应有回归测试：①「suspended/revoked 用户不得访问 member 内容」；②「停用 tier 后，存量有效会员仍可访问」。

## 7. 与 grantMembership 的关系

`grantMembership` 的顺延叠加语义不变（ADR 0001）。新建行 `status` 默认 `active`、`version=0`，并在同事务写一条 `audit_events`（`action='grant'`）。付款审核触发的 grant，其审计事件与付款 `approve` 事件共享 `correlation_id`，并把 `causation_id` 指向该 approve 事件 id（ADR 0002，#6）。

> 注意：续费叠加时新行 `startsAt = 现有 endsAt`（未来时刻），即该 grant 一开始即为派生态 `scheduled`。这是 scheduled 态的真实来源，#4 实现与测试需覆盖「叠加产生的未来 grant」。

## 7.1 v1.2 Membership Bundle

`membership_tiers.entitlements` 是非空 JSON 数组，迁移默认值为 `[]`。Core
只接受 `early_access`、`behind_the_scenes`、`supporter_recognition` 三个稳定
key；API 提交未知 key 时拒绝保存，读取到包含未知 key 的异常存量值时整组按空权益
处理。它不是独立授权事实源，也不创建用户级 grant。

`resolveMembershipAccess()` 先按本稿的状态和时间窗规则找当前有效 membership，再读取
该 membership 所关联的**当前 tier 行**。因此修改 tier 权益会立即作用于现有有效会员，
而 suspended、revoked、expired 或 scheduled membership 不会获得权益。内容与文件授权仍
只按 tier level / `requiredTierId` 判定；v1.2 第一组权益只用于 Core 展示，不改变
`canAccessPost()` 或 `canAccessFile()` 的允许条件。

tier create/update 与 `entity_type='membership_tier'` 的 audit event 在同一事务内提交。
before/after 只包含显式 tier 展示/状态字段和校验后的 entitlement key，不复制请求体、
Stripe Price ID、结构化金额、时间戳或未来新增字段。

## 8. 测试清单（#4 验收）

- 合法转移：active→suspended→active；active→revoked；active extend 后仍 active；suspended extend 后**仍 suspended**（不被恢复）。
- 非法转移：revoked→任何（含 extend）拒绝；过期记录 extend 拒绝。
- 幂等/并发：对已 suspended 再 suspend → `alreadyInState`（不静默 no-op）；双击 extend 第二次因旧 version → `membershipStale`，不重复延期。
- 并发：旧 version 提交 → `membershipStale`，不覆盖新态。
- 回滚：审计写入失败时状态一并回滚（注入失败模拟）。
- 权限：suspended/revoked 会员 `getActiveMembership` 返回 null；**停用 tier 后存量有效会员仍返回有效**（验证已去掉 `tier.isActive` 过滤）。

## 9. 不在本稿范围

- 后台 UI 与时间线展示（#5）。
- 付款事件 schema 与反转/更正（#6）。
- 邮件通知（#7）。
- 批量生命周期操作。
