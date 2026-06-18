# 会员生命周期设计稿（#4）

> 🚧 计划中。本稿为 issue #4 的实现蓝图，落地决策见 [ADR 0001](../adr/0001-membership-lifecycle-model.md)（会员模型）与 [ADR 0002](../adr/0002-audit-and-event-strategy.md)（审计）。
>
> 范围限定 service + schema 层，**不含**后台 UI（#5）、邮件（#7）、付款事件 schema（#6）。

## 1. 目标

为会员引入完整、可审计的生命周期，作为 #5/#6 的地基：

- 显式且校验的状态转移；非法转移确定性拒绝。
- 会员状态变更与历史记录同提交或同回滚。
- 权限判定收敛到唯一的「有效会员」规则。
- 适当场景幂等，并发不静默覆盖。

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

**有效性判定（唯一入口）**：

```txt
有效 ⇔ status = 'active' ∧ startsAt <= now < endsAt ∧ tier.isActive
```

派生态（仅用于展示，不落库）：

- `expired`：`endsAt <= now`
- `scheduled`：`startsAt > now`（预留，当前 grant 默认即时生效）

**允许的转移**（非法转移抛 `ApiError(409, "invalidMembershipTransition")`）：

| 当前 | suspend | resume | revoke | extend |
|---|:--:|:--:|:--:|:--:|
| active | → suspended | — | → revoked | → active |
| suspended | — | → active | → revoked | → active |
| revoked（终态） | — | — | — | — |

- `revoked` 终态不可逆；过期会员重新开通走新的 `grantMembership`。
- `extend` 仅延长 `endsAt`，不改 status；revoked 不可 extend。

## 5. Service API

所有写操作：单事务内「条件更新（含 version 守卫）+ `recordAudit(tx, ...)`」，共享 `correlation_id`。

```ts
type LifecycleActor = { type: "admin" | "system"; id: string | null };

// 条件更新 where id=? and version=? and status in (...允许的来源态)
suspendMembership(id, { reason, actor, expectedVersion }): Promise<Membership>
resumeMembership(id,  { reason, actor, expectedVersion }): Promise<Membership>
revokeMembership(id,  { reason, actor, expectedVersion }): Promise<Membership>
extendMembership(id,  { days,   actor, expectedVersion }): Promise<Membership>
```

返回前 `version` 自增。命中 0 行区分两种错因：

- 行存在但 version 不符 → `ApiError(409, "membershipStale")`（#5 据此提示「已被他人修改，请刷新」）。
- 行存在但 status 不在允许来源态 → `ApiError(409, "invalidMembershipTransition")`。

幂等：`extend` 携带可选 `dedupeKey` 时，重复请求只生效一次（防双击叠加）。`suspend/resume/revoke` 天然幂等于目标态（已是 suspended 再 suspend 返回当前态而非报错，需在实现中明确选择——本稿取「目标态相同则视为成功 no-op」）。

## 6. 权限判定改造

`getActiveMembership` / `getActiveLevel` 增加 `status='active'` 过滤。需全量排查所有「有效会员」读取点：

- 付款开通后的等级比较（`grantMembership` 内的 `getActiveMembership`）。
- 内容三级权限的 member 判定（content 模块）。
- `/me`、tiers、checkout 等前台页面。

> ⚠️ 这是最容易遗漏的一致性面：任何绕过 `getActiveMembership` 直接查 `memberships` 的地方都必须补 `status` 过滤。#12 应有针对「suspended/revoked 用户不得访问 member 内容」的回归测试。

## 7. 与 grantMembership 的关系

`grantMembership` 的顺延叠加语义不变（ADR 0001）。新建行 `status` 默认 `active`、`version=0`，并在同事务写一条 `audit_events`（`action='grant'`）。付款审核触发的 grant，其审计事件与付款 `approve` 事件共享 `correlation_id`（#6）。

## 8. 测试清单（#4 验收）

- 合法转移：active→suspended→active、active→revoked、extend 延长 endsAt。
- 非法转移：revoked→任何、suspended→revoke 后再 resume → 拒绝。
- 幂等：重复 suspend 为 no-op；带 dedupeKey 的 extend 只生效一次。
- 并发：旧 version 提交 → `membershipStale`，不覆盖新态。
- 回滚：审计写入失败时状态一并回滚（注入失败模拟）。
- 权限：suspended/revoked 会员 `getActiveMembership` 返回 null。

## 9. 不在本稿范围

- 后台 UI 与时间线展示（#5）。
- 付款事件 schema 与反转/更正（#6）。
- 邮件通知（#7）。
- 批量生命周期操作。
